"""Bounded, read-only VMD 0002 decoder. Frames use MMD's 30 Hz time base."""
from __future__ import annotations

import hashlib
import math
from pathlib import Path
import struct

MOTION_EXTENSIONS = {".vmd"}
MOTION_PROFILE = "vmd-0002-cp932-right-ik-eye-v1"
MAX_BYTES = 32 * 1024**2
MAX_KEYS = 200_000
MAX_FRAME = 108_000  # One hour; also bounds pathological clip durations.


class Reader:
    def __init__(self, data):
        self.data, self.offset, self.keys = data, 0, 0
        self.truncated_names = set()

    def take(self, size):
        if self.offset + size > len(self.data):
            raise ValueError("VMD 文件截断，关键帧数据不完整")
        value = self.data[self.offset:self.offset + size]
        self.offset += size
        return value

    def unpack(self, fmt):
        values = struct.unpack("<" + fmt, self.take(struct.calcsize("<" + fmt)))
        if any(isinstance(v, float) and (not math.isfinite(v) or abs(v) > 1e6) for v in values):
            raise ValueError("VMD 包含异常数值")
        return values

    def uint(self):
        return self.unpack("I")[0]

    def frame(self):
        value = self.uint()
        if value > MAX_FRAME:
            raise ValueError("动作超过一小时的预览上限")
        return value

    def text(self, size):
        value = self.take(size).split(b"\0", 1)[0]
        try:
            return value.decode("cp932")
        except UnicodeDecodeError as exc:
            # Some MMD exporters cut a two-byte name at the fixed field boundary.
            # Keep the complete prefix, report it, and never invent the missing character.
            if len(value) == size and exc.start == size - 1 and exc.reason == "incomplete multibyte sequence":
                self.truncated_names.add(value.hex())
                return value[:-1].decode("cp932")
            raise ValueError("VMD 名称不是有效的 CP932 编码") from exc

    def count(self, stride, optional=False):
        if optional and self.offset == len(self.data):
            return 0
        value = self.uint()
        self.keys += value
        if self.keys > MAX_KEYS or value * stride > len(self.data) - self.offset:
            raise ValueError("VMD 关键帧数量异常或文件截断")
        return value

    def flag(self):
        value = self.unpack("B")[0]
        if value not in (0, 1):
            raise ValueError("VMD 开关值无效")
        return bool(value)


def parse_vmd(data):
    if len(data) > MAX_BYTES:
        raise ValueError("动作文件超过 32 MB")
    r = Reader(data)
    if r.take(30).rstrip(b"\0") != b"Vocaloid Motion Data 0002":
        raise ValueError("首版仅支持 VMD 0002 动作文件")
    name = r.text(20)
    motions, morphs, cameras, lights, shadows, switches = [], [], [], [], [], []
    for _ in range(r.count(111)):
        bone, frame = r.text(15), r.frame()
        x, y, z, qx, qy, qz, qw = r.unpack("7f")
        interpolation = list(r.take(64))
        if any(v > 127 for v in interpolation[:16]):
            raise ValueError("VMD 骨骼插值超出范围")
        length = math.sqrt(qx*qx + qy*qy + qz*qz + qw*qw)
        if length < 1e-8:
            raise ValueError("VMD 包含零长度旋转四元数")
        motions.append(dict(boneName=bone, frameNum=frame, position=[x, y, -z],
                            rotation=[-qx/length, -qy/length, qz/length, qw/length],
                            interpolation=interpolation))
    for _ in range(r.count(23, optional=True)):
        morphs.append(dict(morphName=r.text(15), frameNum=r.frame(), weight=r.unpack("f")[0]))
    for _ in range(r.count(61, optional=True)):
        frame, distance = r.frame(), r.unpack("f")[0]
        x, y, z, rx, ry, rz = r.unpack("6f")
        interpolation = list(r.take(24))
        fov, orthographic = r.uint(), r.flag()
        if any(v > 127 for v in interpolation) or not 1 <= fov < 180:
            raise ValueError("VMD 镜头参数超出范围")
        cameras.append(dict(frameNum=frame, distance=distance, position=[x, y, -z],
                            rotation=[-rx, -ry, rz], interpolation=interpolation,
                            fov=fov, perspective=int(orthographic)))
    for _ in range(r.count(28, optional=True)):
        lights.append(dict(frameNum=r.frame(), values=list(r.unpack("6f"))))
    for _ in range(r.count(9, optional=True)):
        shadows.append(dict(frameNum=r.frame(), mode=r.unpack("B")[0], distance=r.unpack("f")[0]))
    for _ in range(r.count(9, optional=True)):
        frame, visible = r.frame(), r.flag()
        iks = [dict(name=r.text(20), enabled=r.flag()) for _ in range(r.count(21))]
        switches.append(dict(frameNum=frame, visible=visible, iks=iks))
    if r.offset != len(data):
        raise ValueError("VMD 含无法识别的尾部数据")
    for tracks in (motions, morphs, cameras, lights, shadows, switches):
        tracks.sort(key=lambda k: k["frameNum"])
    active = sorted({k["boneName"] for k in motions if any(abs(v) > 1e-5 for v in k["position"])
                     or any(abs(v) > 1e-5 for v in k["rotation"][:3])})
    max_frame = max((k["frameNum"] for tracks in (motions, morphs, cameras, lights, shadows, switches)
                     for k in tracks), default=0)
    eye_only = bool(motions) and all(k["boneName"] in {"両目", "左目", "右目"} for k in motions)
    kind = "body" if motions and not eye_only else "facial" if morphs or eye_only else "camera" if cameras else "other"
    warnings = []
    if r.truncated_names:
        warnings.append(f"{len(r.truncated_names)} 个源名称被导出器截断，按完整字节前缀匹配")
    if lights or shadows:
        warnings.append("灯光与自阴影轨道已识别；预览使用固定舞台灯光")
    if any(k["perspective"] for k in cameras):
        warnings.append("正交镜头暂按透视投影预览")
    metadata = dict(coordinateSystem="right", name=name, motionCount=len(motions),
                    morphCount=len(morphs), cameraCount=len(cameras))
    info = dict(type=kind, fps=30, frames=max_frame + 1, duration=max_frame / 30,
                bones=len({k["boneName"] for k in motions}), active_bones=active,
                bone_keys=len(motions), morph_keys=len(morphs), camera_keys=len(cameras),
                ik_keys=len(switches), warnings=warnings, target=name)
    return dict(metadata=metadata, motions=motions, morphs=morphs, cameras=cameras,
                switches=switches, info=info)


def read_vmd(path):
    with Path(path).open("rb") as stream:
        data = stream.read(MAX_BYTES + 1)
    result = parse_vmd(data)
    result["info"]["hash"] = hashlib.sha256(data).hexdigest()
    return result
