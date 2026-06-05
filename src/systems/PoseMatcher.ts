import type { Landmark } from "./MotionDetector";
import type { Vec2 } from "../data/poses";

// Local indices within CORE_LANDMARKS = [11,12,13,14,15,16,23,24,25,26,27,28]
const L_SHO = 0;
const R_SHO = 1;
const L_HIP = 6;
const R_HIP = 7;

function toBodySpace(landmarks: Landmark[]): Vec2[] {
  // Use display-space x (mirrored): disp_x = 1 - lm.x
  const hipMidX = 1 - (landmarks[L_HIP].x + landmarks[R_HIP].x) / 2;
  const hipMidY = (landmarks[L_HIP].y + landmarks[R_HIP].y) / 2;
  const shoMidX = 1 - (landmarks[L_SHO].x + landmarks[R_SHO].x) / 2;
  const shoMidY = (landmarks[L_SHO].y + landmarks[R_SHO].y) / 2;

  const torsoLen = Math.sqrt(
    Math.pow(shoMidX - hipMidX, 2) + Math.pow(shoMidY - hipMidY, 2)
  );
  if (torsoLen < 0.01) return landmarks.map(() => ({ x: 0, y: 0 }));

  return landmarks.map(lm => ({
    x: ((1 - lm.x) - hipMidX) / torsoLen,
    y: -(lm.y - hipMidY) / torsoLen, // screen y↓ → body y↑
  }));
}

export class PoseMatcher {
  compare(playerLandmarks: Landmark[], referenceJoints: Vec2[]): number {
    if (playerLandmarks.length !== referenceJoints.length) return 0;

    const normalized = toBodySpace(playerLandmarks);
    let totalDist = 0;
    for (let i = 0; i < normalized.length; i++) {
      const dx = normalized[i].x - referenceJoints[i].x;
      const dy = normalized[i].y - referenceJoints[i].y;
      totalDist += Math.sqrt(dx * dx + dy * dy);
    }
    // avgDist 0 = perfect (1.0), avgDist 2+ = no match (0.0)
    return Math.max(0, Math.min(1, 1 - totalDist / normalized.length / 2));
  }
}
