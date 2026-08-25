"""CK-14 brand-module pins.

The value under test is never the name's current spelling — it is that every
user-visible brand string is BUILT from app/brand.py, so the next rename
touches one constant and nothing else. Hence the sentinel test: a literal that
merely matched brand.PRODUCT_NAME today would pass a value assertion and
still leave the rename a grep.
"""

import json

from app import brand
from app.api import auth as auth_api
from app.config import settings
from app.services import email as email_service
from tests.test_auth import _request_link


async def test_magic_link_subject_built_from_brand_not_a_literal(
    client, capsys, monkeypatch
):
    monkeypatch.setattr(auth_api, "PRODUCT_NAME", "BrandSentinel")
    response = await _request_link(client, "brand-pin@example.com")
    assert response.status_code == 202
    out = capsys.readouterr().out
    assert "Your BrandSentinel sign-in link" in out
    assert "Sign in to BrandSentinel:" in out


async def test_magic_link_subject_carries_the_real_product_name(client, capsys):
    response = await _request_link(client, "brand-live@example.com")
    assert response.status_code == 202
    assert f"Your {brand.PRODUCT_NAME} sign-in link" in capsys.readouterr().out


def test_provider_from_header_built_from_brand_display_name(monkeypatch):
    # EMAIL_FROM is the bare address (environment); the display name is brand.
    monkeypatch.setattr(settings, "email_api_key", "test-key")
    monkeypatch.setattr(settings, "email_from", "keep@example.com")
    request = email_service.build_provider_request(
        to="someone@example.com", subject="s", body="b"
    )
    payload = json.loads(request.data.decode())
    assert payload["from"] == f"{brand.FROM_DISPLAY_NAME} <keep@example.com>"
