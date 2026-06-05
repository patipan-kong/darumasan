import Phaser from "phaser";
import type { Landmark } from "../systems/MotionDetector";
import { StatusText } from "../ui/StatusText";
import { PoseTracker } from "../vision/PoseTracker";
import { REFERENCE_POSE } from "../data/poses";
import type { JointId } from "../data/poses";
import {
  checkFreezeDetection,
  checkPoseMatch,
  normalizePose,
  resetFreezeTimer,
  type FreezeDetectionResult,
  type NormalizedPose,
  type PoseMatchResult
} from "../systems/DarumaPoseUtils";

const POSE_MATCH_THRESHOLD_PERCENT = parseFloat(import.meta.env.VITE_POSE_MATCH_THRESHOLD_PERCENT ?? "78");
const HOLD_DURATION_MS = parseInt(import.meta.env.VITE_HOLD_DURATION_MS ?? "3000", 10);
const MOVEMENT_THRESHOLD = parseFloat(import.meta.env.VITE_MOVEMENT_THRESHOLD ?? "0.045");
const MOVEMENT_SMOOTHING_ALPHA = parseFloat(import.meta.env.VITE_MOVEMENT_SMOOTHING_ALPHA ?? "0.2");

enum GameState {
  WAITING,
  POSING,
  HOLDING,
  SUCCESS,
}

const CORE_LANDMARKS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28] as const satisfies readonly JointId[];

// Absolute landmark index pairs for drawing the player skeleton
const PLAYER_CONNECTIONS: Array<[number, number]> = [
  [11, 12],
  [11, 13], [13, 15],
  [12, 14], [14, 16],
  [11, 23], [12, 24],
  [23, 24],
  [23, 25], [25, 27],
  [24, 26], [26, 28],
];

// Local CORE_LANDMARKS index pairs for drawing the reference silhouette
const CORE_CONNECTIONS: Array<[number, number]> = [
  [0, 1],
  [0, 2], [2, 4],
  [1, 3], [3, 5],
  [0, 6], [1, 7],
  [6, 7],
  [6, 8], [8, 10],
  [7, 9], [9, 11],
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

    try {
      await this.poseTracker.init();
    } catch (error) {
      this.statusText.setCenterMessage("WEBCAM / MODEL ERROR", "#ff5c5c");
      console.error(error);
    }

    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.poseTracker.dispose();
    });
  }

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
      ruleChecks: {
        handsRaised: false,
        rightLegFoldedInward: false
      }
    };

    if (hasPose) {
      const normalized = normalizePose(landmarks);
      normalizeReliable = normalized.isReliable;
      this.lastVisibleJointCount = normalized.visibleJointCount;
      this.lastNormalizeReliable = normalizeReliable;

      if (normalizeReliable) {
        matchResult = checkPoseMatch(normalized.pose, REFERENCE_POSE, POSE_MATCH_THRESHOLD_PERCENT);
        this.lastUsedJointCount = matchResult.usedJointCount;
        this.lastFreezeResult = checkFreezeDetection(normalized.pose, this.previousNormalizedPose, delta, {
          poseMatched: matchResult.passed,
          movementThreshold: MOVEMENT_THRESHOLD,
          holdDurationMs: HOLD_DURATION_MS
        });
        this.previousNormalizedPose = normalized.pose;
      } else {
        resetFreezeTimer();
        this.previousNormalizedPose = null;
        this.lastUsedJointCount = 0;
        this.lastFreezeResult = {
          movementScore: 0,
          foul: false,
          message: "LANDMARK LOW VISIBILITY",
          holdTimeMs: 0,
          holdProgress: 0,
          passed: false,
          comparedJointCount: 0
        };
      }
    } else {
      resetFreezeTimer();
      this.previousNormalizedPose = null;
      this.lastVisibleJointCount = 0;
      this.lastUsedJointCount = 0;
      this.lastNormalizeReliable = false;
      this.lastFreezeResult = {
        movementScore: 0,
        foul: false,
        message: "NO POSE DETECTED",
        holdTimeMs: 0,
        holdProgress: 0,
        passed: false,
        comparedJointCount: 0
      };
    }

    this.lastMatchPercent = matchResult.percentage;
    const rawMovement = Number.isFinite(this.lastFreezeResult.movementScore) ? this.lastFreezeResult.movementScore : 0;
    this.smoothedMovementScore =
      MOVEMENT_SMOOTHING_ALPHA * rawMovement +
      (1 - MOVEMENT_SMOOTHING_ALPHA) * this.smoothedMovementScore;

    this.statusText.setMatchScore(this.lastMatchPercent / 100);
    this.statusText.setMovementScore(this.smoothedMovementScore);
    this.statusText.setFreezeStatus(this.lastFreezeResult.message, this.lastFreezeResult.foul);
    this.statusText.setDebugMetrics(this.lastVisibleJointCount, this.lastUsedJointCount, this.lastNormalizeReliable);
    this.drawOverlay(landmarks);
    this.advanceStateMachine(time, hasPose, normalizeReliable);
  }

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

      case GameState.POSING:
        this.statusText.setCenterMessage(`MATCH: ${REFERENCE_POSE.name}`, "#4dffb8");
        this.statusText.setHoldTime(0, HOLD_DURATION_MS / 1000);
        if (this.lastMatchPercent >= POSE_MATCH_THRESHOLD_PERCENT) this.enterHolding(time);
        break;

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
    this.drawReferenceSilhouette();
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

    this.overlayGraphics.lineStyle(5, 0xffffff, 0.28);
    for (const [a, b] of CORE_CONNECTIONS) {
      const idA = CORE_LANDMARKS[a];
      const idB = CORE_LANDMARKS[b];
      const jointA = REFERENCE_POSE.joints[idA];
      const jointB = REFERENCE_POSE.joints[idB];
      if (!jointA || !jointB) continue;

      const pa = toScreen(jointA);
      const pb = toScreen(jointB);
      this.overlayGraphics.lineBetween(pa.x, pa.y, pb.x, pb.y);
    }

    this.overlayGraphics.fillStyle(0xffffff, 0.45);
    for (const landmarkId of CORE_LANDMARKS) {
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

    this.overlayGraphics.lineStyle(3, color, 0.9);
    for (const [a, b] of PLAYER_CONNECTIONS) {
      if (!landmarks[a] || !landmarks[b]) continue;
      this.overlayGraphics.lineBetween(
        (1 - landmarks[a].x) * width, landmarks[a].y * height,
        (1 - landmarks[b].x) * width, landmarks[b].y * height
      );
    }

    this.overlayGraphics.fillStyle(color, 1);
    for (const idx of CORE_LANDMARKS) {
      if (!landmarks[idx]) continue;
      this.overlayGraphics.fillCircle(
        (1 - landmarks[idx].x) * width,
        landmarks[idx].y * height,
        6
      );
    }
  }

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
