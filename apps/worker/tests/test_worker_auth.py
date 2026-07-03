"""Worker 安全认证单元测试 —— nonce 重放、容量淘汰、bodyHash 校验。"""

from __future__ import annotations

import hashlib
import hmac
import json
import sys
import time
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
WORKER_SRC = REPO_ROOT / "apps" / "worker" / "src"
if str(WORKER_SRC) not in sys.path:
    sys.path.insert(0, str(WORKER_SRC))


def _set_module_attrs(**kwargs: object) -> None:
    """通过导入 sidecar 后直接赋值覆盖全局配置与状态。"""
    import worker_app.sidecar as mod

    for key, value in kwargs.items():
        setattr(mod, key, value)


def _sign(tool_name: str, body: bytes, secret: str, *, iat: int | None = None, exp: int | None = None, nonce: str | None = None, extra: dict | None = None) -> str:
    now = int(time.time())
    payload: dict = {
        "v": 1,
        "toolName": tool_name,
        "iat": iat if iat is not None else now,
        "exp": exp if exp is not None else now + 300,
        "nonce": nonce or f"test-nonce-{now}-{hashlib.sha256(body).hexdigest()[:8]}",
        "bodyHash": hashlib.sha256(body).hexdigest(),
    }
    if extra:
        payload.update(extra)
    import base64

    encoded = base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8")).rstrip(b"=").decode("ascii")
    sig = hmac.new(secret.encode("utf-8"), encoded.encode("utf-8"), hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(sig).rstrip(b"=").decode("ascii")
    return f"GeoForge-Worker {encoded}.{sig_b64}"


class NonceReplayTests(unittest.TestCase):
    """验证 nonce 重放被拒绝。"""

    def setUp(self) -> None:
        _set_module_attrs(
            WORKER_SHARED_SECRET="test-secret-for-replay",
            WORKER_CLOCK_SKEW_SECONDS=30,
            WORKER_NONCE_CACHE_MAX=10000,
        )
        self.mod = __import__("worker_app.sidecar", fromlist=["_verify_worker_authorization", "_seen_nonces"])
        self.mod._seen_nonces.clear()
        self.secret = "test-secret-for-replay"
        self.tool = "meteorological_inspect"
        self.body = b'{"file_relative_path":"data.nc"}'

    def tearDown(self) -> None:
        self.mod._seen_nonces.clear()

    def test_first_nonce_accepted(self) -> None:
        auth = _sign(self.tool, self.body, self.secret)
        err = self.mod._verify_worker_authorization(auth, self.secret, self.tool, self.body)
        self.assertIsNone(err)

    def test_replay_nonce_rejected(self) -> None:
        """同一个 nonce 第二次使用时必须被拒绝。"""
        nonce = "fixed-replay-nonce-001"
        auth = _sign(self.tool, self.body, self.secret, nonce=nonce)
        err1 = self.mod._verify_worker_authorization(auth, self.secret, self.tool, self.body)
        self.assertIsNone(err1, f"首次验证应成功: {err1}")

        err2 = self.mod._verify_worker_authorization(auth, self.secret, self.tool, self.body)
        self.assertIsNotNone(err2, "重放 nonce 应被拒绝")
        self.assertEqual(err2[0], 403)
        self.assertIn("nonce", err2[1])


class NonceCacheCapacityTests(unittest.TestCase):
    """验证 nonce cache 超上限时淘汰最早过期的条目。"""

    def setUp(self) -> None:
        _set_module_attrs(
            WORKER_SHARED_SECRET="test-secret-cap",
            WORKER_CLOCK_SKEW_SECONDS=30,
            WORKER_NONCE_CACHE_MAX=5,
        )
        self.mod = __import__("worker_app.sidecar", fromlist=["_verify_worker_authorization", "_seen_nonces", "_purge_expired_nonces"])
        self.mod._seen_nonces.clear()
        self.secret = "test-secret-cap"
        self.tool = "meteorological_inspect"
        self.body = b'{"file_relative_path":"data.nc"}'

    def tearDown(self) -> None:
        self.mod._seen_nonces.clear()
        _set_module_attrs(WORKER_NONCE_CACHE_MAX=10000)

    def test_overflow_evicts_earliest_exp(self) -> None:
        """超过上限时 exp 最早（最先过期）的 nonce 应被淘汰。"""
        now = int(time.time())
        # 填充 5 个 nonce，exp 递增
        for i in range(5):
            nonce = f"keep-me-{i}"
            self.mod._seen_nonces[nonce] = now + 60 + i  # +60, +61, +62, +63, +64

        self.assertEqual(len(self.mod._seen_nonces), 5)

        newest_nonce = "newest-nonce-entry-001"
        auth = _sign(self.tool, self.body, self.secret, nonce=newest_nonce, exp=now + 65)
        err = self.mod._verify_worker_authorization(auth, self.secret, self.tool, self.body)
        self.assertIsNone(err)
        self.assertLessEqual(len(self.mod._seen_nonces), 5, "应淘汰到上限以内")
        # "keep-me-0" exp=now+60 最早，应该被淘汰
        self.assertNotIn("keep-me-0", self.mod._seen_nonces)
        self.assertIn(newest_nonce, self.mod._seen_nonces)

    def test_within_limit_keeps_all(self) -> None:
        """未超过上限时所有 nonce 均保留。"""
        now = int(time.time())
        for i in range(3):
            nonce = f"keep-{i}"
            self.mod._seen_nonces[nonce] = now + 120
        self.mod._purge_expired_nonces(now)
        self.assertEqual(len(self.mod._seen_nonces), 3)


class BodyHashTests(unittest.TestCase):
    """验证 bodyHash 不匹配被拒绝。"""

    def setUp(self) -> None:
        _set_module_attrs(
            WORKER_SHARED_SECRET="test-secret-bodyhash",
            WORKER_CLOCK_SKEW_SECONDS=30,
        )
        self.mod = __import__("worker_app.sidecar", fromlist=["_verify_worker_authorization", "_seen_nonces"])
        self.mod._seen_nonces.clear()
        self.secret = "test-secret-bodyhash"
        self.tool = "meteorological_inspect"
        self.body = b'{"file_relative_path":"data.nc"}'

    def tearDown(self) -> None:
        self.mod._seen_nonces.clear()

    def test_body_hash_mismatch_rejected(self) -> None:
        """发送 body 与签名中的 bodyHash 不一致时应拒绝。"""
        auth = _sign(self.tool, self.body, self.secret)
        tampered_body = b'{"file_relative_path":"evil.nc"}'
        err = self.mod._verify_worker_authorization(auth, self.secret, self.tool, tampered_body)
        self.assertIsNotNone(err, "bodyHash 不匹配应拒绝")
        self.assertEqual(err[0], 403)
        self.assertIn("哈希", err[1])

    def test_body_hash_match_accepted(self) -> None:
        """bodyHash 匹配时应通过校验。"""
        auth = _sign(self.tool, self.body, self.secret)
        err = self.mod._verify_worker_authorization(auth, self.secret, self.tool, self.body)
        self.assertIsNone(err)


if __name__ == "__main__":
    unittest.main()
