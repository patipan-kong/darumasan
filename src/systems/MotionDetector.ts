export interface Landmark {
  x: number;
  y: number;
  z: number;
}

export interface MotionResult {
  movementScore: number;
  isStill: boolean;
}

const SMOOTHING_ALPHA = 0.2;

export class MotionDetector {
  private readonly movementThreshold: number;
  private previousLandmarks: Landmark[] | null = null;
  private smoothedScore = 0;

  constructor(movementThreshold = 0.05) {
    this.movementThreshold = movementThreshold;
  }

  public analyze(landmarks: Landmark[]): MotionResult {
    if (!this.previousLandmarks || this.previousLandmarks.length !== landmarks.length) {
      this.previousLandmarks = landmarks.map((point) => ({ ...point }));
      return { movementScore: 0, isStill: true };
    }

    let rawScore = 0;
    for (let i = 0; i < landmarks.length; i += 1) {
      const prev = this.previousLandmarks[i];
      const curr = landmarks[i];
      const dx = curr.x - prev.x;
      const dy = curr.y - prev.y;
      const dz = curr.z - prev.z;
      rawScore += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    this.smoothedScore = SMOOTHING_ALPHA * rawScore + (1 - SMOOTHING_ALPHA) * this.smoothedScore;
    this.previousLandmarks = landmarks.map((point) => ({ ...point }));

    return {
      movementScore: this.smoothedScore,
      isStill: this.smoothedScore < this.movementThreshold
    };
  }

  public reset(): void {
    this.previousLandmarks = null;
    this.smoothedScore = 0;
  }
}
