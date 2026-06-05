export interface InputLandmark {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export type BodyMode = 'full_body' | 'upper_body';

export const CORE_LANDMARK_IDS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28] as const;
export const UPPER_BODY_LANDMARK_IDS = [11, 12, 13, 14, 15, 16] as const;
export const LOWER_BODY_LANDMARK_IDS = [25, 26, 27, 28] as const;

export type CoreLandmarkId = (typeof CORE_LANDMARK_IDS)[number];
export type NormalizedPose = Partial<Record<CoreLandmarkId, Vec2>>;

export function getActiveJointIds(mode: BodyMode): readonly CoreLandmarkId[] {
  return mode === 'upper_body' ? UPPER_BODY_LANDMARK_IDS : CORE_LANDMARK_IDS;
}

export interface NormalizePoseResult {
  pose: NormalizedPose;
  visibleJointCount: number;
  missingJointIds: CoreLandmarkId[];
  isReliable: boolean;
}

export interface ReferencePoseObject {
  name?: string;
  joints:
    | Partial<Record<number, Vec2>>
    | Vec2[];
}

export interface PoseMatchResult {
  percentage: number;
  passed: boolean;
  averageDistance: number;
  distanceScore: number;
  fallbackBonus: number;
  usedJointCount: number;
  ruleChecks: {
    handsRaised: boolean;
    rightLegFoldedInward: boolean;
  };
}

export interface FreezeDetectionResult {
  movementScore: number;
  foul: boolean;
  message: string;
  holdTimeMs: number;
  holdProgress: number;
  passed: boolean;
  comparedJointCount: number;
}

export interface FreezeDetectionOptions {
  movementThreshold?: number;
  holdDurationMs?: number;
  poseMatched?: boolean;
  mode?: BodyMode;
}

const MIN_VISIBILITY = 0.5;
const FALLBACK_BONUS_PER_RULE = 0.075;
const DEFAULT_POSE_PASS_THRESHOLD_PERCENT = 78;
const DEFAULT_MOVEMENT_THRESHOLD = 0.045;
const DEFAULT_HOLD_DURATION_MS = 3000;

let freezeHoldTimerMs = 0;

function isLandmarkVisible(lm: InputLandmark | undefined): lm is InputLandmark {
  if (!lm) return false;
  return lm.visibility === undefined || lm.visibility >= MIN_VISIBILITY;
}

function toReferenceMap(referencePose: ReferencePoseObject): Partial<Record<CoreLandmarkId, Vec2>> {
  const map: Partial<Record<CoreLandmarkId, Vec2>> = {};

  if (Array.isArray(referencePose.joints)) {
    for (let i = 0; i < CORE_LANDMARK_IDS.length; i += 1) {
      const id = CORE_LANDMARK_IDS[i];
      const p = referencePose.joints[i];
      if (!p) continue;
      map[id] = { x: p.x, y: p.y };
    }
    return map;
  }

  for (const id of CORE_LANDMARK_IDS) {
    const point = referencePose.joints[id];
    if (!point) continue;
    map[id] = { x: point.x, y: point.y };
  }

  return map;
}

// Normalize reference using hip midpoint as origin (full body mode)
function toBodyNormalizedReference(referencePose: ReferencePoseObject): Partial<Record<CoreLandmarkId, Vec2>> {
  const raw = toReferenceMap(referencePose);
  const leftShoulder = raw[11];
  const rightShoulder = raw[12];
  const leftHip = raw[23];
  const rightHip = raw[24];

  if (!leftShoulder || !rightShoulder || !leftHip || !rightHip) {
    return raw;
  }

  const hipMidX = (leftHip.x + rightHip.x) / 2;
  const hipMidY = (leftHip.y + rightHip.y) / 2;
  const shoulderWidth = Math.hypot(rightShoulder.x - leftShoulder.x, rightShoulder.y - leftShoulder.y);

  if (shoulderWidth < 1e-5) {
    return raw;
  }

  const normalized: Partial<Record<CoreLandmarkId, Vec2>> = {};
  for (const id of CORE_LANDMARK_IDS) {
    const point = raw[id];
    if (!point) continue;

    normalized[id] = {
      x: (hipMidX - point.x) / shoulderWidth,
      y: (hipMidY - point.y) / shoulderWidth
    };
  }

  return normalized;
}

// Normalize reference using shoulder midpoint as origin (upper body mode)
function toBodyNormalizedReferenceUpperBody(referencePose: ReferencePoseObject): Partial<Record<CoreLandmarkId, Vec2>> {
  const raw = toReferenceMap(referencePose);
  const leftShoulder = raw[11];
  const rightShoulder = raw[12];

  if (!leftShoulder || !rightShoulder) {
    return raw;
  }

  const shoulderMidX = (leftShoulder.x + rightShoulder.x) / 2;
  const shoulderMidY = (leftShoulder.y + rightShoulder.y) / 2;
  const shoulderWidth = Math.hypot(rightShoulder.x - leftShoulder.x, rightShoulder.y - leftShoulder.y);

  if (shoulderWidth < 1e-5) {
    return raw;
  }

  const normalized: Partial<Record<CoreLandmarkId, Vec2>> = {};
  for (const id of UPPER_BODY_LANDMARK_IDS) {
    const point = raw[id];
    if (!point) continue;

    normalized[id] = {
      x: (shoulderMidX - point.x) / shoulderWidth,
      y: (shoulderMidY - point.y) / shoulderWidth
    };
  }

  return normalized;
}

/**
 * Convert MediaPipe coordinates (0..1) to body-normalized coordinates.
 * Full body: hip midpoint as origin, shoulder width as scale.
 * Upper body: shoulder midpoint as origin, shoulder width as scale (works seated).
 */
export function normalizePose(currentLandmarks: InputLandmark[], mode: BodyMode = 'full_body'): NormalizePoseResult {
  const missingJointIds: CoreLandmarkId[] = [];
  const normalized: NormalizedPose = {};

  const leftShoulder = currentLandmarks[11];
  const rightShoulder = currentLandmarks[12];

  if (!isLandmarkVisible(leftShoulder)) missingJointIds.push(11);
  if (!isLandmarkVisible(rightShoulder)) missingJointIds.push(12);

  if (mode === 'upper_body') {
    if (missingJointIds.length > 0) {
      return { pose: normalized, visibleJointCount: 0, missingJointIds, isReliable: false };
    }

    const shoulderMidX = (leftShoulder.x + rightShoulder.x) / 2;
    const shoulderMidY = (leftShoulder.y + rightShoulder.y) / 2;
    const shoulderWidth = Math.hypot(rightShoulder.x - leftShoulder.x, rightShoulder.y - leftShoulder.y);

    if (shoulderWidth < 1e-5) {
      return {
        pose: normalized,
        visibleJointCount: 0,
        missingJointIds: [...missingJointIds, ...UPPER_BODY_LANDMARK_IDS],
        isReliable: false
      };
    }

    let visibleJointCount = 0;
    for (const id of UPPER_BODY_LANDMARK_IDS) {
      const lm = currentLandmarks[id];
      if (!isLandmarkVisible(lm)) {
        missingJointIds.push(id);
        continue;
      }
      normalized[id] = {
        x: (shoulderMidX - lm.x) / shoulderWidth,
        y: (shoulderMidY - lm.y) / shoulderWidth
      };
      visibleJointCount += 1;
    }

    return {
      pose: normalized,
      visibleJointCount,
      missingJointIds,
      isReliable: visibleJointCount >= 4
    };
  }

  // Full body mode
  const leftHip = currentLandmarks[23];
  const rightHip = currentLandmarks[24];

  if (!isLandmarkVisible(leftHip)) missingJointIds.push(23);
  if (!isLandmarkVisible(rightHip)) missingJointIds.push(24);

  if (missingJointIds.length > 0) {
    return { pose: normalized, visibleJointCount: 0, missingJointIds, isReliable: false };
  }

  const hipMidX = (leftHip.x + rightHip.x) / 2;
  const hipMidY = (leftHip.y + rightHip.y) / 2;
  const shoulderWidth = Math.hypot(rightShoulder.x - leftShoulder.x, rightShoulder.y - leftShoulder.y);

  if (shoulderWidth < 1e-5) {
    return {
      pose: normalized,
      visibleJointCount: 0,
      missingJointIds: [...missingJointIds, ...CORE_LANDMARK_IDS],
      isReliable: false
    };
  }

  let visibleJointCount = 0;
  for (const id of CORE_LANDMARK_IDS) {
    const lm = currentLandmarks[id];
    if (!isLandmarkVisible(lm)) {
      missingJointIds.push(id);
      continue;
    }

    normalized[id] = {
      x: (hipMidX - lm.x) / shoulderWidth,
      y: (hipMidY - lm.y) / shoulderWidth
    };
    visibleJointCount += 1;
  }

  return {
    pose: normalized,
    visibleJointCount,
    missingJointIds,
    isReliable: visibleJointCount >= 8
  };
}

/**
 * Compare player pose against reference using only the joints active for the given mode.
 * Upper body mode uses shoulder-midpoint normalization; full body uses hip-midpoint.
 */
export function checkPoseMatch(
  normalizedPlayerPose: NormalizedPose,
  referencePose: ReferencePoseObject,
  passThresholdPercent = DEFAULT_POSE_PASS_THRESHOLD_PERCENT,
  mode: BodyMode = 'full_body'
): PoseMatchResult {
  const refMap = mode === 'upper_body'
    ? toBodyNormalizedReferenceUpperBody(referencePose)
    : toBodyNormalizedReference(referencePose);

  const activeIds = getActiveJointIds(mode);
  const minUsedJoints = mode === 'upper_body' ? 4 : 8;

  let totalDistance = 0;
  let usedJointCount = 0;

  for (const id of activeIds) {
    const p = normalizedPlayerPose[id];
    const r = refMap[id];
    if (!p || !r) continue;

    totalDistance += Math.hypot(p.x - r.x, p.y - r.y);
    usedJointCount += 1;
  }

  const averageDistance = usedJointCount > 0 ? totalDistance / usedJointCount : Number.POSITIVE_INFINITY;
  const distanceScore = usedJointCount > 0 ? Math.max(0, 1 - averageDistance / 1.2) : 0;

  // Fallback Rule #1: Both wrists above shoulders (valid in both modes)
  const handsRaised = Boolean(
    normalizedPlayerPose[15] && normalizedPlayerPose[16] &&
    normalizedPlayerPose[11] && normalizedPlayerPose[12] &&
    normalizedPlayerPose[15]!.y > normalizedPlayerPose[11]!.y &&
    normalizedPlayerPose[16]!.y > normalizedPlayerPose[12]!.y
  );

  // Fallback Rule #2: Right ankle inside right knee (lower body only, not valid in upper body mode)
  const rightLegFoldedInward = mode === 'full_body' && Boolean(
    normalizedPlayerPose[28] && normalizedPlayerPose[26] &&
    normalizedPlayerPose[28]!.x < normalizedPlayerPose[26]!.x
  );

  const fallbackBonus =
    (handsRaised ? FALLBACK_BONUS_PER_RULE : 0) +
    (rightLegFoldedInward ? FALLBACK_BONUS_PER_RULE : 0);

  const percentage = Math.max(0, Math.min(100, Math.round((distanceScore + fallbackBonus) * 100)));
  const passed = usedJointCount >= minUsedJoints && percentage >= passThresholdPercent;

  return {
    percentage,
    passed,
    averageDistance,
    distanceScore,
    fallbackBonus,
    usedJointCount,
    ruleChecks: {
      handsRaised,
      rightLegFoldedInward
    }
  };
}

/**
 * Compare two already-normalized poses directly (no re-normalization step).
 * Used by the self-match test: capturing the current pose as the reference and
 * comparing the next frame against it should yield 95-100% with no movement.
 *
 * Because both sides are in the same coordinate space this is the ground-truth
 * check for whether the distance/scoring math is correct.
 */
export function checkPoseMatchNormalized(
  currentPose: NormalizedPose,
  referencePose: NormalizedPose,
  passThresholdPercent = DEFAULT_POSE_PASS_THRESHOLD_PERCENT,
  mode: BodyMode = 'full_body'
): PoseMatchResult {
  const activeIds = getActiveJointIds(mode);
  const minUsedJoints = mode === 'upper_body' ? 4 : 8;

  let totalDistance = 0;
  let usedJointCount = 0;

  for (const id of activeIds) {
    const p = currentPose[id];
    const r = referencePose[id];
    if (!p || !r) continue;
    totalDistance += Math.hypot(p.x - r.x, p.y - r.y);
    usedJointCount += 1;
  }

  const averageDistance = usedJointCount > 0 ? totalDistance / usedJointCount : Number.POSITIVE_INFINITY;
  const distanceScore = usedJointCount > 0 ? Math.max(0, 1 - averageDistance / 1.2) : 0;

  const handsRaised = Boolean(
    currentPose[15] && currentPose[16] &&
    currentPose[11] && currentPose[12] &&
    currentPose[15]!.y > currentPose[11]!.y &&
    currentPose[16]!.y > currentPose[12]!.y
  );

  const rightLegFoldedInward = mode === 'full_body' && Boolean(
    currentPose[28] && currentPose[26] &&
    currentPose[28]!.x < currentPose[26]!.x
  );

  const fallbackBonus =
    (handsRaised ? FALLBACK_BONUS_PER_RULE : 0) +
    (rightLegFoldedInward ? FALLBACK_BONUS_PER_RULE : 0);

  const percentage = Math.max(0, Math.min(100, Math.round((distanceScore + fallbackBonus) * 100)));
  const passed = usedJointCount >= minUsedJoints && percentage >= passThresholdPercent;

  return {
    percentage,
    passed,
    averageDistance,
    distanceScore,
    fallbackBonus,
    usedJointCount,
    ruleChecks: { handsRaised, rightLegFoldedInward }
  };
}

/**
 * Reset the hold timer (call when starting a new round or switching modes).
 */
export function resetFreezeTimer(): void {
  freezeHoldTimerMs = 0;
}

/**
 * Detect frame-to-frame movement and accumulate hold time.
 * Only joints active for the given mode are compared.
 */
export function checkFreezeDetection(
  currentPose: NormalizedPose,
  previousPose: NormalizedPose | null,
  deltaTime: number,
  options: FreezeDetectionOptions = {}
): FreezeDetectionResult {
  const movementThreshold = options.movementThreshold ?? DEFAULT_MOVEMENT_THRESHOLD;
  const holdDurationMs = options.holdDurationMs ?? DEFAULT_HOLD_DURATION_MS;
  const poseMatched = options.poseMatched ?? true;
  const activeIds = getActiveJointIds(options.mode ?? 'full_body');

  if (!previousPose) {
    if (!poseMatched) freezeHoldTimerMs = 0;
    return {
      movementScore: 0,
      foul: false,
      message: poseMatched ? "เริ่มจับนิ่ง" : "ท่ายังไม่ตรง",
      holdTimeMs: freezeHoldTimerMs,
      holdProgress: freezeHoldTimerMs / holdDurationMs,
      passed: false,
      comparedJointCount: 0
    };
  }

  let totalDelta = 0;
  let comparedJointCount = 0;
  for (const id of activeIds) {
    const curr = currentPose[id];
    const prev = previousPose[id];
    if (!curr || !prev) continue;

    totalDelta += Math.hypot(curr.x - prev.x, curr.y - prev.y);
    comparedJointCount += 1;
  }

  const movementScore = comparedJointCount > 0 ? totalDelta / comparedJointCount : Number.POSITIVE_INFINITY;
  const foul = comparedJointCount > 0 && movementScore > movementThreshold;

  if (!poseMatched || foul) {
    freezeHoldTimerMs = 0;
  } else {
    freezeHoldTimerMs = Math.min(holdDurationMs, freezeHoldTimerMs + Math.max(deltaTime, 0));
  }

  const passed = freezeHoldTimerMs >= holdDurationMs;
  let message = "นิ่งดี";
  if (!poseMatched) {
    message = "ท่ายังไม่ตรง";
  } else if (foul) {
    message = "ขยับตัว/ฟาวล์";
  } else if (passed) {
    message = "ผ่านเงื่อนไขค้างท่า";
  }

  return {
    movementScore,
    foul,
    message,
    holdTimeMs: freezeHoldTimerMs,
    holdProgress: holdDurationMs > 0 ? freezeHoldTimerMs / holdDurationMs : 0,
    passed,
    comparedJointCount
  };
}
