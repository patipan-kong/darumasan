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

export const CORE_LANDMARK_IDS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28] as const;

export type CoreLandmarkId = (typeof CORE_LANDMARK_IDS)[number];
export type NormalizedPose = Partial<Record<CoreLandmarkId, Vec2>>;

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
}

const MIN_VISIBILITY = 0.5;
const FALLBACK_BONUS_PER_RULE = 0.075;
const DEFAULT_POSE_PASS_THRESHOLD_PERCENT = 78;
const DEFAULT_MOVEMENT_THRESHOLD = 0.045;
const DEFAULT_HOLD_DURATION_MS = 3000;

let freezeHoldTimerMs = 0;

function isLandmarkVisible(lm: InputLandmark | undefined): lm is InputLandmark {
  if (!lm) return false;
  // ถ้าไม่มีค่า visibility จาก MediaPipe ให้ถือว่าใช้ได้ (บางรุ่น/model ไม่ส่งฟิลด์นี้)
  return lm.visibility === undefined || lm.visibility >= MIN_VISIBILITY;
}

function toReferenceMap(referencePose: ReferencePoseObject): Partial<Record<CoreLandmarkId, Vec2>> {
  const map: Partial<Record<CoreLandmarkId, Vec2>> = {};

  if (Array.isArray(referencePose.joints)) {
    // รองรับโครงสร้างเดิมในโปรเจกต์: joints เป็น array เรียงตาม CORE_LANDMARK_IDS
    for (let i = 0; i < CORE_LANDMARK_IDS.length; i += 1) {
      const id = CORE_LANDMARK_IDS[i];
      const p = referencePose.joints[i];
      if (!p) continue;
      map[id] = { x: p.x, y: p.y };
    }
    return map;
  }

  // รองรับโครงสร้างตามที่ผู้ใช้ยกตัวอย่าง: joints เป็น object key ตาม landmark id
  for (const id of CORE_LANDMARK_IDS) {
    const point = referencePose.joints[id];
    if (!point) continue;
    map[id] = { x: point.x, y: point.y };
  }

  return map;
}

/**
 * แปลงพิกัด MediaPipe (0..1) ให้เป็นพิกัดแบบ Body-Normalized
 * - ย้าย origin ไปที่จุดกึ่งกลางสะโพก (23,24)
 * - ใช้ความกว้างหัวไหล่ (11-12) เป็น scale
 * - แปลงแกน y ให้ "ค่ามาก = สูงขึ้น" เพื่อคำนวณท่าง่ายขึ้น
 */
export function normalizePose(currentLandmarks: InputLandmark[]): NormalizePoseResult {
  const missingJointIds: CoreLandmarkId[] = [];
  const normalized: NormalizedPose = {};

  const leftShoulder = currentLandmarks[11];
  const rightShoulder = currentLandmarks[12];
  const leftHip = currentLandmarks[23];
  const rightHip = currentLandmarks[24];

  // 4 จุดหลักต้องเห็นชัดพอ ไม่งั้น normalize จะเพี้ยน
  if (!isLandmarkVisible(leftShoulder)) missingJointIds.push(11);
  if (!isLandmarkVisible(rightShoulder)) missingJointIds.push(12);
  if (!isLandmarkVisible(leftHip)) missingJointIds.push(23);
  if (!isLandmarkVisible(rightHip)) missingJointIds.push(24);

  if (missingJointIds.length > 0) {
    return {
      pose: normalized,
      visibleJointCount: 0,
      missingJointIds,
      isReliable: false
    };
  }

  const hipMidX = (leftHip.x + rightHip.x) / 2;
  const hipMidY = (leftHip.y + rightHip.y) / 2;
  const shoulderWidth = Math.hypot(rightShoulder.x - leftShoulder.x, rightShoulder.y - leftShoulder.y);

  // กันหารศูนย์/ท่ากลายเป็นเส้นเดียวจาก noise
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
      x: (lm.x - hipMidX) / shoulderWidth,
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
 * ตรวจว่าท่าผู้เล่นใกล้เคียงท่าอ้างอิงแค่ไหน
 * - วัด Euclidean distance รายจุดในระนาบ x,y
 * - เติม rule-based fallback เพื่อให้เล่นง่ายขึ้นในโลกจริง
 */
export function checkPoseMatch(
  normalizedPlayerPose: NormalizedPose,
  referencePose: ReferencePoseObject,
  passThresholdPercent = DEFAULT_POSE_PASS_THRESHOLD_PERCENT
): PoseMatchResult {
  const refMap = toReferenceMap(referencePose);

  let totalDistance = 0;
  let usedJointCount = 0;

  for (const id of CORE_LANDMARK_IDS) {
    const p = normalizedPlayerPose[id];
    const r = refMap[id];
    if (!p || !r) continue;

    totalDistance += Math.hypot(p.x - r.x, p.y - r.y);
    usedJointCount += 1;
  }

  const averageDistance = usedJointCount > 0 ? totalDistance / usedJointCount : Number.POSITIVE_INFINITY;
  // distanceScore: 1 = ตรงมาก, 0 = ต่างมาก
  const distanceScore = usedJointCount > 0 ? Math.max(0, 1 - averageDistance / 1.2) : 0;

  // Fallback Rule #1: ข้อมือสูงกว่าไหล่ทั้งสองข้าง (หลัง normalize: y มากกว่า = สูงกว่า)
  const handsRaised = Boolean(
    normalizedPlayerPose[15] && normalizedPlayerPose[16] &&
    normalizedPlayerPose[11] && normalizedPlayerPose[12] &&
    normalizedPlayerPose[15]!.y > normalizedPlayerPose[11]!.y &&
    normalizedPlayerPose[16]!.y > normalizedPlayerPose[12]!.y
  );

  // Fallback Rule #2: ข้อเท้าขวาอยู่ซ้ายกว่าเข่าขวา (พับขาเข้าด้านใน)
  const rightLegFoldedInward = Boolean(
    normalizedPlayerPose[28] && normalizedPlayerPose[26] &&
    normalizedPlayerPose[28]!.x < normalizedPlayerPose[26]!.x
  );

  const fallbackBonus =
    (handsRaised ? FALLBACK_BONUS_PER_RULE : 0) +
    (rightLegFoldedInward ? FALLBACK_BONUS_PER_RULE : 0);

  const percentage = Math.max(0, Math.min(100, Math.round((distanceScore + fallbackBonus) * 100)));

  // ถ้ามีจุดใช้เทียบน้อยเกินไป ให้ไม่ผ่านแม้เปอร์เซ็นต์ดูสวย
  const passed = usedJointCount >= 8 && percentage >= passThresholdPercent;

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
 * รีเซ็ตตัวนับการค้างท่า (ควรเรียกเมื่อเริ่มรอบใหม่)
 */
export function resetFreezeTimer(): void {
  freezeHoldTimerMs = 0;
}

/**
 * ตรวจจับการขยับเฟรมต่อเฟรม + นับเวลาค้างท่า
 * เงื่อนไขชนะ: ท่าถูกต้อง + ขยับไม่เกิน threshold ต่อเนื่อง >= holdDurationMs
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
  for (const id of CORE_LANDMARK_IDS) {
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
