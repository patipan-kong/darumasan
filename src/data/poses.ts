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
