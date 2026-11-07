"""Хеш паролів — scrypt зі стандартної бібліотеки (без нових залежностей).

Формат: scrypt$<n>$<r>$<p>$<salt b64>$<hash b64>. Параметри зберігаються в рядку, тож їх
можна посилити пізніше без міграції: старі хеші перевіряються зі своїми параметрами.
"""

import asyncio
import base64
import hashlib
import hmac
import secrets

N, R, P, DKLEN = 2**14, 8, 1, 64


def _derive(password: str, salt: bytes, n: int, r: int, p: int) -> bytes:
    return hashlib.scrypt(password.encode(), salt=salt, n=n, r=r, p=p, dklen=DKLEN, maxmem=2**26)


def hash_password_sync(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = _derive(password, salt, N, R, P)
    b64 = base64.b64encode
    return f"scrypt${N}${R}${P}${b64(salt).decode()}${b64(digest).decode()}"


def verify_password_sync(password: str, encoded: str | None) -> bool:
    if not encoded:
        return False
    try:
        scheme, n, r, p, salt, digest = encoded.split("$")
        if scheme != "scrypt":
            return False
        expected = base64.b64decode(digest)
        actual = _derive(password, base64.b64decode(salt), int(n), int(r), int(p))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


async def hash_password(password: str) -> str:
    """scrypt навмисно повільний (~50 мс) — у потоці, щоб не блокувати event loop."""
    return await asyncio.to_thread(hash_password_sync, password)


async def verify_password(password: str, encoded: str | None) -> bool:
    return await asyncio.to_thread(verify_password_sync, password, encoded)
