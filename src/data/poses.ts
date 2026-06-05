export interface Vec2 {
  x: number;
  y: number;
}

export interface ReferencePose {
  name: string;
  // Body-normalized joint positions in display (mirrored) space
  // Origin = hip midpoint, y+ = visual up, 1 unit = torso length
  // Order matches CORE_LANDMARKS = [11,12,13,14,15,16,23,24,25,26,27,28]
  joints: Vec2[];
}

export type JointId = 11 | 12 | 13 | 14 | 15 | 16 | 23 | 24 | 25 | 26 | 27 | 28;

export type ReferencePoseMap = {
  name: string;
  joints: Record<JointId, Vec2>;
};

export const REFERENCE_POSE: ReferencePoseMap = {
  name: "Y_POSE_STAND_LEFT_RAISE_RIGHT",
  joints: {
    11: { x: -0.20, y: 0.35 },
    12: { x: 0.20, y: 0.35 },
    13: { x: -0.40, y: 0.15 },
    14: { x: 0.40, y: 0.15 },
    15: { x: -0.55, y: -0.10 },
    16: { x: 0.55, y: -0.10 },
    23: { x: -0.15, y: 0.65 },
    24: { x: 0.15, y: 0.65 },
    25: { x: -0.15, y: 0.85 },
    26: { x: 0.35, y: 0.75 },
    27: { x: -0.15, y: 1.05 },
    28: { x: 0.10, y: 0.80 }
  }
};

export const REFERENCE_POSES: ReferencePose[] = [
  {
    name: "Y POSE",
    joints: [
      { x: -0.25, y:  1.00 }, // 11 L shoulder
      { x:  0.25, y:  1.00 }, // 12 R shoulder
      { x: -0.60, y:  1.38 }, // 13 L elbow
      { x:  0.60, y:  1.38 }, // 14 R elbow
      { x: -0.90, y:  1.72 }, // 15 L wrist
      { x:  0.90, y:  1.72 }, // 16 R wrist
      { x: -0.15, y:  0.00 }, // 23 L hip
      { x:  0.15, y:  0.00 }, // 24 R hip
      { x: -0.15, y: -0.90 }, // 25 L knee (standing)
      { x:  0.35, y:  0.25 }, // 26 R knee (raised)
      { x: -0.15, y: -1.75 }, // 27 L ankle (standing)
      { x:  0.45, y: -0.25 }, // 28 R ankle (raised, hanging)
    ],
  },
];
