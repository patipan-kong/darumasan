import Phaser from "phaser";
import type { Landmark } from "../systems/MotionDetector";
import { PoseMatcher } from "../systems/PoseMatcher";
import { StatusText } from "../ui/StatusText";
import { PoseTracker } from "../vision/PoseTracker";
import { REFERENCE_POSES } from "../data/poses";
import type { ReferencePose } from "../data/poses";

const POSE_MATCH_THRESHOLD = parseFloat(import.meta.env.VITE_POSE_MATCH_THRESHOLD ?? "0.65");
const HOLD_DURATION_MS = parseInt(import.meta.env.VITE_HOLD_DURATION_MS ?? "3000", 10);

enum GameState {
  WAITING,
  POSING,
  HOLDING,
  SUCCESS,
}

const CORE_LANDMARKS = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];

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
  private poseMatcher: PoseMatcher;
  private statusText: StatusText | null = null;
  private state: GameState = GameState.WAITING;
  private webcamTexture: Phaser.Textures.CanvasTexture | null = null;
  private webcamImage: Phaser.GameObjects.Image | null = null;
  private overlayGraphics: Phaser.GameObjects.Graphics | null = null;
  private holdTimerMs = 0;
  private lastMatchScore = 0;
  private currentPoseIndex = 0;
  private lastPoseUpdateMs = 0;
  private stateChangedAtMs = 0;

  constructor() {
    super("GameScene");
    this.poseTracker = new PoseTracker();
    this.poseMatcher = new PoseMatcher();
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

    const coreLandmarks = landmarks.length > 0
      ? CORE_LANDMARKS.map(i => landmarks[i])
      : [];

    const currentPose = REFERENCE_POSES[this.currentPoseIndex];

    this.lastMatchScore = coreLandmarks.length > 0
      ? this.poseMatcher.compare(coreLandmarks, currentPose.joints)
      : 0;

    this.statusText.setMatchScore(this.lastMatchScore);
    this.drawOverlay(landmarks, currentPose);
    this.advanceStateMachine(time, delta, coreLandmarks.length > 0, currentPose);
  }

  private advanceStateMachine(
    time: number,
    delta: number,
    hasPose: boolean,
    pose: ReferencePose
  ): void {
    if (!this.statusText) return;

    const isMatching = this.lastMatchScore >= POSE_MATCH_THRESHOLD;

    if (!hasPose) {
      this.state = GameState.WAITING;
      this.holdTimerMs = 0;
      this.statusText.setCenterMessage("NO POSE DETECTED", "#ffd966");
      this.statusText.setHoldTime(0, HOLD_DURATION_MS / 1000);
      return;
    }

    switch (this.state) {
      case GameState.WAITING:
        this.enterPosing(time);
        break;

      case GameState.POSING:
        this.statusText.setCenterMessage(`MATCH: ${pose.name}`, "#4dffb8");
        this.statusText.setHoldTime(0, HOLD_DURATION_MS / 1000);
        if (isMatching) this.enterHolding(time);
        break;

      case GameState.HOLDING:
        this.statusText.setCenterMessage("HOLD IT!", "#ffcc00");
        if (isMatching) {
          this.holdTimerMs += delta;
          this.statusText.setHoldTime(this.holdTimerMs / 1000, HOLD_DURATION_MS / 1000);
          if (this.holdTimerMs >= HOLD_DURATION_MS) this.enterSuccess(time);
        } else {
          this.enterPosing(time);
        }
        break;

      case GameState.SUCCESS:
        this.statusText.setCenterMessage("PERFECT!", "#7dff75");
        this.statusText.setHoldTime(HOLD_DURATION_MS / 1000, HOLD_DURATION_MS / 1000);
        if (time - this.stateChangedAtMs > 2000) {
          this.currentPoseIndex = (this.currentPoseIndex + 1) % REFERENCE_POSES.length;
          this.enterPosing(time);
        }
        break;
    }
  }

  private enterPosing(time: number): void {
    this.state = GameState.POSING;
    this.stateChangedAtMs = time;
    this.holdTimerMs = 0;
  }

  private enterHolding(time: number): void {
    this.state = GameState.HOLDING;
    this.stateChangedAtMs = time;
    this.holdTimerMs = 0;
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

  private drawOverlay(landmarks: Landmark[], pose: ReferencePose): void {
    if (!this.overlayGraphics) return;
    this.overlayGraphics.clear();
    this.drawReferenceSilhouette(pose);
    if (landmarks.length > 0) this.drawPlayerSkeleton(landmarks);
  }

  private drawReferenceSilhouette(pose: ReferencePose): void {
    if (!this.overlayGraphics) return;

    const { width, height } = this.scale;
    const cx = width / 2;
    const cy = height * 0.54;
    const scale = height * 0.22;

    const toScreen = (j: { x: number; y: number }) => ({
      x: cx + j.x * scale,
      y: cy - j.y * scale,
    });

    this.overlayGraphics.lineStyle(5, 0xffffff, 0.28);
    for (const [a, b] of CORE_CONNECTIONS) {
      const pa = toScreen(pose.joints[a]);
      const pb = toScreen(pose.joints[b]);
      this.overlayGraphics.lineBetween(pa.x, pa.y, pb.x, pb.y);
    }

    this.overlayGraphics.fillStyle(0xffffff, 0.45);
    for (const joint of pose.joints) {
      const p = toScreen(joint);
      this.overlayGraphics.fillCircle(p.x, p.y, 6);
    }
  }

  private drawPlayerSkeleton(landmarks: Landmark[]): void {
    if (!this.overlayGraphics) return;

    const color = this.lastMatchScore >= POSE_MATCH_THRESHOLD ? 0x3cff8e : 0x00b4ff;
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
