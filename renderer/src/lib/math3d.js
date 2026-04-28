export function project(pt, cam) {
  const { yaw, pitch, scale, ox, oy } = cam;
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  let x = pt[0] * cy + pt[2] * sy;
  let z = -pt[0] * sy + pt[2] * cy;
  let y = pt[1] * cp - z * sp;
  let zp = pt[1] * sp + z * cp;
  return { x: ox + x * scale, y: oy - y * scale, z: zp };
}

export function applyT(T, p) {
  return [
    T[0][0]*p[0] + T[0][1]*p[1] + T[0][2]*p[2] + T[0][3],
    T[1][0]*p[0] + T[1][1]*p[1] + T[1][2]*p[2] + T[1][3],
    T[2][0]*p[0] + T[2][1]*p[1] + T[2][2]*p[2] + T[2][3],
  ];
}

export function makeT(rx, ry, rz, tx, ty, tz) {
  const cx = Math.cos(rx), sx = Math.sin(rx);
  const cy = Math.cos(ry), sy = Math.sin(ry);
  const cz = Math.cos(rz), sz = Math.sin(rz);
  return [
    [cz*cy, cz*sy*sx - sz*cx, cz*sy*cx + sz*sx, tx],
    [sz*cy, sz*sy*sx + cz*cx, sz*sy*cx - cz*sx, ty],
    [-sy,   cy*sx,            cy*cx,            tz],
    [0,0,0,1],
  ];
}

export function composeT(A, B) {
  const r = [[0,0,0,0],[0,0,0,0],[0,0,0,0],[0,0,0,1]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 4; j++) {
    r[i][j] = A[i][0]*B[0][j] + A[i][1]*B[1][j] + A[i][2]*B[2][j] + (j === 3 ? A[i][3] : 0);
  }
  return r;
}

// SE(3) inverse: [R | t; 0 1] -> [R^T | -R^T t; 0 1]. Assumes T is a proper rigid transform.
export function invT(T) {
  const tx = -(T[0][0]*T[0][3] + T[1][0]*T[1][3] + T[2][0]*T[2][3]);
  const ty = -(T[0][1]*T[0][3] + T[1][1]*T[1][3] + T[2][1]*T[2][3]);
  const tz = -(T[0][2]*T[0][3] + T[1][2]*T[1][3] + T[2][2]*T[2][3]);
  return [
    [T[0][0], T[1][0], T[2][0], tx],
    [T[0][1], T[1][1], T[2][1], ty],
    [T[0][2], T[1][2], T[2][2], tz],
    [0, 0, 0, 1],
  ];
}
