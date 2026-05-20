#!/usr/bin/env python3
"""Build a canonical umi.json from a post-VIO MCAP using MCAP log_time.

Bypasses /recording/import_mcap, which reads PoseInFrame.timestamp — empty in
the Genrobot VIO output and so produces all-zero ts. log_time is wall-clock
(epoch s) from the Genrobot host and is what the sync pipeline expects.

Optional --ts-shift adds a constant offset to every ts (use this to align
two hosts whose clocks differ by more than the ±5 s cross-correlation cap).

  backend/.venv/bin/python scripts/build_umi_json.py \\
      --mcap dataset/rotate/output/..._ego_vio.mcap \\
      --topic /robot0/vio/eef_pose \\
      --out  dataset/rotate/umi.json \\
      [--ts-shift 142.0]
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
from mcap.reader import make_reader
from mcap_protobuf.decoder import DecoderFactory


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--mcap", required=True, type=Path)
    p.add_argument("--topic", default="/robot0/vio/eef_pose")
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--ts-shift", default=0.0, type=float,
                   help="add this many seconds to every ts (default 0)")
    args = p.parse_args()

    if not args.mcap.is_file():
        sys.stderr.write(f"mcap not found: {args.mcap}\n")
        return 1

    samples = []
    n_drop_quat = 0
    n_seen = 0
    with open(args.mcap, "rb") as f:
        reader = make_reader(f, decoder_factories=[DecoderFactory()])
        for _schema, _channel, msg, pb in reader.iter_decoded_messages(topics=[args.topic]):
            n_seen += 1
            ts = msg.log_time / 1e9 + args.ts_shift
            qx, qy, qz, qw = pb.pose.orientation.x, pb.pose.orientation.y, pb.pose.orientation.z, pb.pose.orientation.w
            qnorm = (qx * qx + qy * qy + qz * qz + qw * qw) ** 0.5
            if qnorm < 0.5:
                n_drop_quat += 1
                continue
            qx, qy, qz, qw = qx / qnorm, qy / qnorm, qz / qnorm, qw / qnorm
            R = np.array([
                [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
                [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
                [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
            ])
            T = np.eye(4)
            T[:3, :3] = R
            T[:3, 3] = [pb.pose.position.x, pb.pose.position.y, pb.pose.position.z]
            samples.append({"ts": float(ts), "T": T.tolist()})

    if n_seen == 0:
        sys.stderr.write(f"no messages on topic {args.topic!r}\n")
        return 2

    out = {
        "meta": {
            "kind": "umi",
            "n": len(samples),
            "t_first": samples[0]["ts"],
            "t_last": samples[-1]["ts"],
            "topic": args.topic,
            "n_dropped_quat": n_drop_quat,
            "ts_shift_applied_s": args.ts_shift,
            "ts_source": "mcap.log_time",
        },
        "samples": samples,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(out))
    print(f"wrote {args.out}")
    print(f"  n={len(samples)} (dropped {n_drop_quat} degenerate quats)")
    print(f"  t_first={samples[0]['ts']:.3f}  t_last={samples[-1]['ts']:.3f}  dur={samples[-1]['ts']-samples[0]['ts']:.1f}s")
    print(f"  ts shift applied: {args.ts_shift:+.3f} s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
