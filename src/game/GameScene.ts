import Phaser from "phaser";
import type { Landmark } from "../systems/MotionDetector";
import { StatusText } from "../ui/StatusText";
import { PoseTracker } from "../vision/PoseTracker";
import { REFERENCE_POSE } from "../data/poses";
import type { JointId } from "../data/poses";
import {
  checkFreezeDetection,
  checkPoseMatch,
  checkPoseMatchNormalized,
  normalizePose,
  resetFreezeTimer,
  getActiveJointIds,
  type BodyMode,
  type CoreLandmarkId,
  type FreezeDetectionResult,
  type NormalizedPose,
  type PoseMatchResult,
  LOWER_BODY_LANDMARK_IDS,
  UPPER_BODY_LANDMARK_IDS,
} from "../systems/DarumaPoseUtils";

const POSE_MATCH_THRESHOLD_PERCENT = parseFloat(import.meta.env.VITE_POSE_MATCH_THRESHOLD_PERCENT ?? "78");
const HOLD_DURATION_MS = parseInt(import.meta.env.VITE_HOLD_DURATION_MS ?? "3000", 10);
const MOVEMENT_THRESHOLD = parseFloat(import.meta.env.VITE_MOVEMENT_THRESHOLD ?? "0.045");
const MOVEMENT_SMOOTHING_ALPHA = parseFloat(import.meta.env.VITE_MOVEMENT_SMOOTHING_ALPHA ?? "0.2");
const LOWER_BODY_AUTO_WARN_MS = 2000;
const SELF_MATCH_DEBUG_INTERVAL_MS = 1000;

enum GameState {
  WAITING,
  POSING,
  HOLDING,
  SUCCESS,
}

const FULL_BODY_LANDMARKS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28] as const satisfies readonly JointId[];

const FULL_BODY_CONNECTIONS: Array<[number, number]> = [
  [11, 12],
  [11, 13], [13, 15],
  [12, 14], [14, 16],
  [11, 23], [12, 24],
  [23, 24],
  [23, 25], [25, 27],
  [24, 26], [26, 28],
];

const UPPER_BODY_CONNECTIONS: Array<[number, number]> = [
  [11, 12],
  [11, 13], [13, 15],
  [12, 14], [14, 16],
];

const FULL_BODY_CORE_CONNECTIONS: Array<[number, number]> = [
  [0, 1],
  [0, 2], [2, 4],
  [1, 3], [3, 5],
  [0, 6], [1, 7],
  [6, 7],
  [6, 8], [8, 10],
  [7, 9], [9, 11],
];

const UPPER_BODY_CORE_CONNECTIONS: Array<[number, number]> = [
  [0, 1],
  [0, 2], [2, 4],
  [1, 3], [3, 5],
];

export class GameScene extends Phaser.Scene {
  private poseTracker: PoseTracker;
  private statusText: StatusText | null = null;
  private state: GameState = GameState.WAITING;
  private webcamTexture: Phaser.Textures.CanvasTexture | null = null;
  private webcamImage: Phaser.GameObjects.Image | null = null;
  private overlayGraphics: Phaser.GameObjects.Graphics | null = null;
  private previousNormalizedPose: NormalizedPose | null = null;
  private lastMatchPercent = 0;
  private smoothedMovementScore = 0;
  private lastVisibleJointCount = 0;
  private lastUsedJointCount = 0;
  private lastNormalizeReliable = false;
  private lastFreezeResult: FreezeDetectionResult = {
    movementScore: 0,
    foul: false,
    message: "",
    holdTimeMs: 0,
    holdProgress: 0,
    passed: false,
    comparedJointCount: 0
  };
  private lastPoseUpdateMs = 0;
  private stateChangedAtMs = 0;

  private bodyMode: BodyMode = 'full_body';
  private lowerBodyNotVisibleMs = 0;
  private modeToggleBtn: HTMLButtonElement | null = null;

  // Self-match test state
  private capturedSelfPose: NormalizedPose | null = null;
  private currentNormalizedPose: NormalizedPose | null = null;
  private selfMatchBtn: HTMLButtonElement | null = null;
  private selfMatchDebugLastMs = -Infinity;

  constructor() {
    super("GameScene");
    this.poseTracker = new PoseTracker();
  }

  public async create(): Promise<void> {
    const { width, height } = this.scale;
    this.statusText = new StatusText(this, width, height);
    this.overlayGraphics = this.add.graphics().setDepth(10);

    this.webcamTexture = this.textures.createCanvas("webcam-feed", width, height);
    this.webcamImage = this.add
      .image(width / 2, height / 2, "webcam-feed")
      .setDisplaySize(width, height)
      .setDepth(1);

    this.modeToggleBtn = this.createModeToggleButton();
    this.selfMatchBtn = this.createSelfMatchButton();

    try {
      await this.poseTracker.init();
    } catch (error) {
      this.statusText.setCenterMessage("WEBCAM / MODEL ERROR", "#ff5c5c");
      console.error(error);
    }

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.poseTracker.dispose();
      this.modeToggleBtn?.remove();
      this.modeToggleBtn = null;
      this.selfMatchBtn?.remove();
      this.selfMatchBtn = null;
    });
  }

  // ─── Mode toggle ───────────────────────────────────────────────────────────

  private createModeToggleButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = 'Upper Body Mode';
    Object.assign(btn.style, {
      position: 'fixed', top: '16px', right: '16px', zIndex: '1000',
      padding: '9px 16px', background: 'rgba(10,20,45,0.88)',
      color: '#4dffb8', border: '2px solid #4dffb8', borderRadius: '7px',
      fontFamily: 'Consolas, monospace', fontSize: '15px', cursor: 'pointer',
    });
    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(30,60,90,0.95)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(10,20,45,0.88)'; });
    btn.addEventListener('click', () => this.toggleBodyMode());
    document.body.appendChild(btn);
    return btn;
  }

  private toggleBodyMode(): void {
    this.bodyMode = this.bodyMode === 'full_body' ? 'upper_body' : 'full_body';
    this.lowerBodyNotVisibleMs = 0;
    resetFreezeTimer();
    this.previousNormalizedPose = null;
    this.currentNormalizedPose = null;
    // Invalidate self-match when mode changes — coordinate spaces differ
    if (this.capturedSelfPose !== null) {
      this.capturedSelfPose = null;
      this.updateSelfMatchButton();
    }
    this.updateModeButton();
    this.statusText?.setMode(
      this.bodyMode === 'full_body' ? 'FULL BODY' : 'UPPER BODY',
      this.bodyMode === 'upper_body'
    );
    this.statusText?.setLowerBodyWarning('');
  }

  private updateModeButton(): void {
    if (!this.modeToggleBtn) return;
    const isUpper = this.bodyMode === 'upper_body';
    this.modeToggleBtn.textContent = isUpper ? 'Full Body Mode' : 'Upper Body Mode';
    this.modeToggleBtn.style.color = isUpper ? '#ffcc44' : '#4dffb8';
    this.modeToggleBtn.style.borderColor = isUpper ? '#ffcc44' : '#4dffb8';
  }

  // ─── Self-match capture ────────────────────────────────────────────────────

  private createSelfMatchButton(): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = 'Capture Pose As Reference';
    Object.assign(btn.style, {
      position: 'fixed', top: '60px', right: '16px', zIndex: '1000',
      padding: '9px 16px', background: 'rgba(10,20,45,0.88)',
      color: '#ffaa44', border: '2px solid #ffaa44', borderRadius: '7px',
      fontFamily: 'Consolas, monospace', fontSize: '15px', cursor: 'pointer',
    });
    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(50,30,10,0.95)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(10,20,45,0.88)'; });
    btn.addEventListener('click', () => this.captureSelfPose());
    document.body.appendChild(btn);
    return btn;
  }

  private captureSelfPose(): void {
    // Toggle off
    if (this.capturedSelfPose !== null) {
      this.capturedSelfPose = null;
      this.selfMatchDebugLastMs = -Infinity;
      this.updateSelfMatchButton();
      this.statusText?.setMode(
        this.bodyMode === 'full_body' ? 'FULL BODY' : 'UPPER BODY',
        this.bodyMode === 'upper_body'
      );
      console.log('[SelfMatch] Cleared — reverted to authored reference pose.');
      return;
    }

    if (!this.currentNormalizedPose || Object.keys(this.currentNormalizedPose).length === 0) {
      console.warn('[SelfMatch] No reliable pose detected yet. Stand in frame first.');
      return;
    }

    // Deep copy
    const copy: NormalizedPose = {};
    for (const [key, val] of Object.entries(this.currentNormalizedPose) as [string, { x: number; y: number }][]) {
      const id = Number(key) as CoreLandmarkId;
      copy[id] = { x: val.x, y: val.y };
    }

    this.capturedSelfPose = copy;
    this.selfMatchDebugLastMs = -Infinity;
    this.updateSelfMatchButton();
    this.statusText?.setMode('SELF-MATCH', true);

    const activeIds = getActiveJointIds(this.bodyMode);
    const capturedCount = activeIds.filter(id => copy[id]).length;
    console.group('[SelfMatch] Pose captured — expect 95-100% score without moving');
    console.log(`Mode: ${this.bodyMode} | Active joints captured: ${capturedCount}/${activeIds.length}`);
    console.log('Captured joint positions:');
    for (const id of activeIds) {
      const v = copy[id];
      console.log(`  joint ${id}: ${v ? `x=${v.x.toFixed(4)}, y=${v.y.toFixed(4)}` : 'MISSING'}`);
    }
    console.groupEnd();
  }

  private updateSelfMatchButton(): void {
    if (!this.selfMatchBtn) return;
    const active = this.capturedSelfPose !== null;
    this.selfMatchBtn.textContent = active ? 'Clear Self-Match' : 'Capture Pose As Reference';
    this.selfMatchBtn.style.color = active ? '#ff6666' : '#ffaa44';
    this.selfMatchBtn.style.borderColor = active ? '#ff6666' : '#ffaa44';
  }

  // ─── Main update ───────────────────────────────────────────────────────────

  public update(time: number, delta: number): void {
    if (!this.statusText || !this.webcamTexture || !this.overlayGraphics) return;

    this.drawWebcamFrame();

    let landmarks = this.poseTracker.getLandmarks();
    if (time - this.lastPoseUpdateMs >= 33) {
      landmarks = this.poseTracker.detect(time);
      this.lastPoseUpdateMs = time;
    }

    const hasPose = landmarks.length > 0;
    let normalizeReliable = false;
    let matchResult: PoseMatchResult = {
      percentage: 0,
      passed: false,
      averageDistance: Number.POSITIVE_INFINITY,
      distanceScore: 0,
      fallbackBonus: 0,
      usedJointCount: 0,
      ruleChecks: { handsRaised: false, rightLegFoldedInward: false }
    };

    if (hasPose) {
      this.updateLowerBodyAutoDetect(landmarks, delta);

      const normalized = normalizePose(landmarks, this.bodyMode);
      normalizeReliable = normalized.isReliable;
      this.lastVisibleJointCount = normalized.visibleJointCount;
      this.lastNormalizeReliable = normalizeReliable;

      if (normalizeReliable) {
        this.currentNormalizedPose = normalized.pose;

        if (this.capturedSelfPose !== null) {
          matchResult = checkPoseMatchNormalized(
            normalized.pose, this.capturedSelfPose,
            POSE_MATCH_THRESHOLD_PERCENT, this.bodyMode
          );
          // Debug report when score stays unexpectedly low
          if (matchResult.percentage < 90 && time - this.selfMatchDebugLastMs > SELF_MATCH_DEBUG_INTERVAL_MS) {
            this.selfMatchDebugLastMs = time;
            this.printSelfMatchDebug(normalized.pose, matchResult);
          }
        } else {
          matchResult = checkPoseMatch(normalized.pose, REFERENCE_POSE, POSE_MATCH_THRESHOLD_PERCENT, this.bodyMode);
        }

        this.lastUsedJointCount = matchResult.usedJointCount;
        this.lastFreezeResult = checkFreezeDetection(normalized.pose, this.previousNormalizedPose, delta, {
          poseMatched: matchResult.passed,
          movementThreshold: MOVEMENT_THRESHOLD,
          holdDurationMs: HOLD_DURATION_MS,
          mode: this.bodyMode,
        });
        this.previousNormalizedPose = normalized.pose;
      } else {
        resetFreezeTimer();
        this.previousNormalizedPose = null;
        this.lastUsedJointCount = 0;
        this.lastFreezeResult = {
          movementScore: 0, foul: false, message: "LANDMARK LOW VISIBILITY",
          holdTimeMs: 0, holdProgress: 0, passed: false, comparedJointCount: 0
        };
      }
    } else {
      resetFreezeTimer();
      this.previousNormalizedPose = null;
      this.currentNormalizedPose = null;
      this.lastVisibleJointCount = 0;
      this.lastUsedJointCount = 0;
      this.lastNormalizeReliable = false;
      this.lowerBodyNotVisibleMs = 0;
      this.lastFreezeResult = {
        movementScore: 0, foul: false, message: "NO POSE DETECTED",
        holdTimeMs: 0, holdProgress: 0, passed: false, comparedJointCount: 0
      };
    }

    this.lastMatchPercent = matchResult.percentage;
    const rawMovement = Number.isFinite(this.lastFreezeResult.movementScore) ? this.lastFreezeResult.movementScore : 0;
    this.smoothedMovementScore =
      MOVEMENT_SMOOTHING_ALPHA * rawMovement +
      (1 - MOVEMENT_SMOOTHING_ALPHA) * this.smoothedMovementScore;

    const totalJoints = this.bodyMode === 'upper_body' ? 6 : 12;
    this.statusText.setMatchScore(this.lastMatchPercent / 100);
    this.statusText.setMovementScore(this.smoothedMovementScore);
    this.statusText.setFreezeStatus(this.lastFreezeResult.message, this.lastFreezeResult.foul);
    this.statusText.setDebugMetrics(this.lastVisibleJointCount, this.lastUsedJointCount, totalJoints, this.lastNormalizeReliable);
    this.drawOverlay(landmarks);
    this.advanceStateMachine(time, hasPose, normalizeReliable);
  }

  // ─── Lower-body auto-detect ────────────────────────────────────────────────

  private updateLowerBodyAutoDetect(landmarks: Landmark[], delta: number): void {
    if (!this.statusText) return;

    if (this.bodyMode === 'upper_body') {
      this.lowerBodyNotVisibleMs = 0;
      return;
    }

    const anyLowerVisible = LOWER_BODY_LANDMARK_IDS.some(id => {
      const lm = landmarks[id];
      return lm && (lm.visibility === undefined || lm.visibility >= 0.5);
    });

    if (anyLowerVisible) {
      this.lowerBodyNotVisibleMs = 0;
      this.statusText.setLowerBodyWarning('');
    } else {
      this.lowerBodyNotVisibleMs += delta;
      if (this.lowerBodyNotVisibleMs >= LOWER_BODY_AUTO_WARN_MS) {
        this.statusText.setLowerBodyWarning('Lower body not detected\nTry Upper Body Mode');
      }
    }
  }

  // ─── State machine ────────────────────────────────────────────────────────

  private advanceStateMachine(time: number, hasPose: boolean, normalizeReliable: boolean): void {
    if (!this.statusText) return;

    if (!hasPose) {
      this.state = GameState.WAITING;
      resetFreezeTimer();
      this.statusText.setCenterMessage("NO POSE DETECTED", "#ffd966");
      this.statusText.setHoldTime(0, HOLD_DURATION_MS / 1000);
      return;
    }

    if (!normalizeReliable) {
      this.state = GameState.WAITING;
      this.statusText.setCenterMessage("LOW VISIBILITY", "#ffd966");
      this.statusText.setHoldTime(0, HOLD_DURATION_MS / 1000);
      return;
    }

    if (this.lastFreezeResult.passed && this.state !== GameState.SUCCESS) {
      this.enterSuccess(time);
    }

    switch (this.state) {
      case GameState.WAITING:
        this.enterPosing(time);
        break;

      case GameState.POSING: {
        const refLabel = this.capturedSelfPose !== null ? 'SELF-MATCH REF' : REFERENCE_POSE.name;
        this.statusText.setCenterMessage(`MATCH: ${refLabel}`, "#4dffb8");
        this.statusText.setHoldTime(0, HOLD_DURATION_MS / 1000);
        if (this.lastMatchPercent >= POSE_MATCH_THRESHOLD_PERCENT) this.enterHolding(time);
        break;
      }

      case GameState.HOLDING:
        if (this.lastFreezeResult.foul) {
          this.statusText.setCenterMessage("MOVE DETECTED!", "#ff5f5f");
          this.enterPosing(time);
        } else {
          this.statusText.setCenterMessage("FREEZE!", "#ffcc00");
          this.statusText.setHoldTime(this.lastFreezeResult.holdTimeMs / 1000, HOLD_DURATION_MS / 1000);
        }
        break;

      case GameState.SUCCESS:
        this.statusText.setCenterMessage("PERFECT!", "#7dff75");
        this.statusText.setHoldTime(HOLD_DURATION_MS / 1000, HOLD_DURATION_MS / 1000);
        if (time - this.stateChangedAtMs > 2000) {
          this.enterPosing(time);
        }
        break;
    }
  }

  private enterPosing(time: number): void {
    this.state = GameState.POSING;
    this.stateChangedAtMs = time;
    this.smoothedMovementScore = 0;
    resetFreezeTimer();
  }

  private enterHolding(time: number): void {
    this.state = GameState.HOLDING;
    this.stateChangedAtMs = time;
  }

  private enterSuccess(time: number): void {
    this.state = GameState.SUCCESS;
    this.stateChangedAtMs = time;
    this.playSuccessBeep();
  }

  // ─── Rendering ────────────────────────────────────────────────────────────

  private drawWebcamFrame(): void {
    if (!this.webcamTexture) return;
    const video = this.poseTracker.getVideoElement();
    if (!video || video.readyState < 2) return;

    const context = this.webcamTexture.getContext();
    const { width, height } = this.webcamTexture;
    context.save();
    context.clearRect(0, 0, width, height);
    context.translate(width, 0);
    context.scale(-1, 1);
    context.drawImage(video, 0, 0, width, height);
    context.restore();
    this.webcamTexture.refresh();
  }

  private drawOverlay(landmarks: Landmark[]): void {
    if (!this.overlayGraphics) return;
    this.overlayGraphics.clear();
    // In self-match mode there is no static reference pose to ghost — skip silhouette
    if (this.capturedSelfPose === null) this.drawReferenceSilhouette();
    if (landmarks.length > 0) this.drawPlayerSkeleton(landmarks);
  }

  private drawReferenceSilhouette(): void {
    if (!this.overlayGraphics) return;

    const { width, height } = this.scale;
    const cx = width / 2;
    const leftHip = REFERENCE_POSE.joints[23];
    const rightHip = REFERENCE_POSE.joints[24];
    const refHipY = leftHip && rightHip ? (leftHip.y + rightHip.y) / 2 : 0.65;
    const hipScreenY = height * 0.6;
    const scale = height * 0.55;

    const toScreen = (j: { x: number; y: number }) => ({
      x: cx + j.x * scale,
      y: hipScreenY + (j.y - refHipY) * scale,
    });

    const isUpperBody = this.bodyMode === 'upper_body';
    const activeLandmarks = isUpperBody ? UPPER_BODY_LANDMARK_IDS : FULL_BODY_LANDMARKS;
    const coreConnections = isUpperBody ? UPPER_BODY_CORE_CONNECTIONS : FULL_BODY_CORE_CONNECTIONS;

    this.overlayGraphics.lineStyle(5, 0xffffff, 0.28);
    for (const [a, b] of coreConnections) {
      const idA = activeLandmarks[a];
      const idB = activeLandmarks[b];
      const jointA = REFERENCE_POSE.joints[idA];
      const jointB = REFERENCE_POSE.joints[idB];
      if (!jointA || !jointB) continue;

      const pa = toScreen(jointA);
      const pb = toScreen(jointB);
      this.overlayGraphics.lineBetween(pa.x, pa.y, pb.x, pb.y);
    }

    this.overlayGraphics.fillStyle(0xffffff, 0.45);
    for (const landmarkId of activeLandmarks) {
      const joint = REFERENCE_POSE.joints[landmarkId];
      if (!joint) continue;
      const p = toScreen(joint);
      this.overlayGraphics.fillCircle(p.x, p.y, 6);
    }
  }

  private drawPlayerSkeleton(landmarks: Landmark[]): void {
    if (!this.overlayGraphics) return;

    const color = this.lastMatchPercent >= POSE_MATCH_THRESHOLD_PERCENT ? 0x3cff8e : 0x00b4ff;
    const { width, height } = this.scale;
    const isUpperBody = this.bodyMode === 'upper_body';
    const activeConnections = isUpperBody ? UPPER_BODY_CONNECTIONS : FULL_BODY_CONNECTIONS;
    const activeLandmarks = isUpperBody ? UPPER_BODY_LANDMARK_IDS : FULL_BODY_LANDMARKS;

    this.overlayGraphics.lineStyle(3, color, 0.9);
    for (const [a, b] of activeConnections) {
      if (!landmarks[a] || !landmarks[b]) continue;
      this.overlayGraphics.lineBetween(
        (1 - landmarks[a].x) * width, landmarks[a].y * height,
        (1 - landmarks[b].x) * width, landmarks[b].y * height
      );
    }

    this.overlayGraphics.fillStyle(color, 1);
    for (const idx of activeLandmarks) {
      if (!landmarks[idx]) continue;
      this.overlayGraphics.fillCircle(
        (1 - landmarks[idx].x) * width,
        landmarks[idx].y * height,
        6
      );
    }
  }

  // ─── Self-match diagnostics ───────────────────────────────────────────────

  private printSelfMatchDebug(currentPose: NormalizedPose, matchResult: PoseMatchResult): void {
    if (!this.capturedSelfPose) return;

    const activeIds = getActiveJointIds(this.bodyMode);

    console.group(
      `%c[SelfMatch] Score ${matchResult.percentage}% — BELOW 90%`,
      'color: #ff6644; font-weight: bold'
    );

    console.log('%cReference pose (captured):', 'color: #88aaff; font-weight: bold');
    for (const id of activeIds) {
      const r = this.capturedSelfPose[id];
      console.log(`  joint ${id}: ${r ? `x=${r.x.toFixed(5)}, y=${r.y.toFixed(5)}` : '⚠ MISSING'}`);
    }

    console.log('%cCurrent pose:', 'color: #88ffaa; font-weight: bold');
    for (const id of activeIds) {
      const p = currentPose[id];
      console.log(`  joint ${id}: ${p ? `x=${p.x.toFixed(5)}, y=${p.y.toFixed(5)}` : '⚠ MISSING'}`);
    }

    console.log('%cPer-joint distances (current vs reference):', 'color: #ffdd88; font-weight: bold');
    for (const id of activeIds) {
      const p = currentPose[id];
      const r = this.capturedSelfPose[id];
      if (p && r) {
        const d = Math.hypot(p.x - r.x, p.y - r.y);
        const flag = d > 0.05 ? ' ⚠ large' : '';
        console.log(`  joint ${id}: ${d.toFixed(5)}${flag}`);
      } else {
        console.log(`  joint ${id}: SKIPPED — ${!p ? 'current missing' : 'reference missing'}`);
      }
    }

    const minUsed = this.bodyMode === 'upper_body' ? 4 : 8;
    console.log('%cDiagnosis:', 'color: #ff88aa; font-weight: bold');
    console.log(`  avgDistance    : ${matchResult.averageDistance.toFixed(5)}`);
    console.log(`  distanceScore  : ${matchResult.distanceScore.toFixed(5)}  (raw, before bonus)`);
    console.log(`  fallbackBonus  : +${(matchResult.fallbackBonus * 100).toFixed(1)}%`);
    console.log(`  usedJoints     : ${matchResult.usedJointCount} / ${activeIds.length}  (need ≥${minUsed})`);
    console.log(`  finalPercent   : ${matchResult.percentage}%`);

    if (matchResult.usedJointCount < minUsed) {
      console.error(`  ✗ FAIL: only ${matchResult.usedJointCount} joints matched — need ${minUsed}.`);
      console.error('    → Some joints present in reference but absent in current pose (or vice versa).');
      console.error('    → Check visibility thresholds in normalizePose().');
    } else if (matchResult.averageDistance > 0.05) {
      console.error(`  ✗ FAIL: high average distance ${matchResult.averageDistance.toFixed(4)} despite same pose.`);
      console.error('    → Normalization anchor (hip/shoulder midpoint) is shifting between frames.');
      console.error('    → May indicate large camera noise or unstable body position.');
    } else if (matchResult.distanceScore < 0.9) {
      console.error(`  ✗ FAIL: distanceScore=${matchResult.distanceScore.toFixed(4)} maps to < 90%.`);
      console.error('    → 1 - avgDist/1.2 formula is too strict for this distance. Review the divisor (1.2).');
    } else {
      console.warn('  ? Score below 90% but no clear single cause. Check fallbackBonus and threshold values.');
    }

    console.groupEnd();
  }

  // ─── Audio ────────────────────────────────────────────────────────────────

  private playSuccessBeep(): void {
    const AudioCtx = window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;

    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(740, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1040, ctx.currentTime + 0.2);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.36);
  }
}
