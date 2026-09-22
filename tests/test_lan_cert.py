"""The self-signed certificate behind theDAW's LAN HTTPS listener.

The bug this exists for: a second PC opening theDAW at ``http://<lan-ip>:5173``
is not a secure context, so its browser withholds ``AudioContext.audioWorklet``
and the EDIT tab dies on ``Cannot read properties of undefined (reading
'addModule')``. Serving TLS needs a certificate, and the certificate has to
cover whatever LAN address DHCP handed out this morning -- which is why
"is the one on disk still good?" is a real decision and not a file-exists check.

:func:`backend.lib.lan_cert.cert_matches` is deliberately pure over the text
``openssl x509`` prints, so most of this file runs on a machine with no openssl
at all. The generation tests need the real binary and skip with a reason
without it.
"""

from __future__ import annotations

import logging
import socket
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from backend.lib import lan_cert

# Captured verbatim from `openssl x509 -in c.pem -noout -ext subjectAltName
# -enddate` (OpenSSL 3.5.3). Note "IP Address:" here versus the "IP:" form
# -addext takes, and the trailing space after the extension's name.
OPENSSL_TEXT = (
    "X509v3 Subject Alternative Name: \n"
    "    IP Address:192.168.1.34, IP Address:127.0.0.1, "
    "DNS:localhost, DNS:testhost\n"
    "notAfter=Oct 24 01:32:57 2027 GMT\n"
)

# The same shape with a single-digit day, which openssl pads with a second
# space. strptime on the raw string fails on this; the parser collapses runs.
OPENSSL_TEXT_SHORT_DAY = (
    "X509v3 Subject Alternative Name: \n"
    "    IP Address:10.0.0.5, DNS:localhost\n"
    "notAfter=Oct  4 01:32:57 2027 GMT\n"
)

NOW = datetime(2026, 9, 21, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the whole writable data tree at a temp directory."""
    monkeypatch.setenv("theDAW_DATA_DIR", str(tmp_path))
    return tmp_path


def _openssl() -> str | None:
    return lan_cert.find_openssl()


needs_openssl = pytest.mark.skipif(
    _openssl() is None,
    reason="no openssl on this machine (it ships with Git for Windows)",
)


# --------------------------------------------------------------------------
# desired_sans
# --------------------------------------------------------------------------


def test_desired_sans_is_the_lan_ip_then_loopback_then_names():
    assert lan_cert.desired_sans(["192.168.1.34"], "tasmo-pc") == [
        "IP:192.168.1.34",
        "IP:127.0.0.1",
        "DNS:localhost",
        "DNS:tasmo-pc",
    ]


def test_desired_sans_still_covers_loopback_with_no_lan_ip():
    """A machine off the network still serves its own browser over TLS, so the
    certificate must be usable rather than empty."""
    assert lan_cert.desired_sans([], "") == ["IP:127.0.0.1", "DNS:localhost"]


def test_desired_sans_covers_every_interface():
    assert lan_cert.desired_sans(["192.168.1.34", "10.8.0.2"], "pc") == [
        "IP:192.168.1.34",
        "IP:10.8.0.2",
        "IP:127.0.0.1",
        "DNS:localhost",
        "DNS:pc",
    ]


def test_desired_sans_never_repeats_an_entry():
    """gethostname() returns "localhost" on some configurations, and a caller
    can pass loopback in the list. openssl rejects a duplicated SAN."""
    sans = lan_cert.desired_sans(["127.0.0.1", "", "  "], "localhost")
    assert sans == ["IP:127.0.0.1", "DNS:localhost"]


def test_desired_sans_drops_a_hostname_openssl_would_reject():
    """A hostname with a space or an underscore fails -addext and would take
    the whole generation down with it, leaving the LAN with no listener."""
    assert "DNS:my pc" not in lan_cert.desired_sans(["10.0.0.2"], "my pc")
    assert "DNS:my_pc" not in lan_cert.desired_sans(["10.0.0.2"], "my_pc")
    assert lan_cert.desired_sans(["10.0.0.2"], "my pc") == [
        "IP:10.0.0.2",
        "IP:127.0.0.1",
        "DNS:localhost",
    ]


def test_desired_sans_keeps_a_dotted_hostname():
    assert "DNS:tasmo-pc.local" in lan_cert.desired_sans(["10.0.0.2"], "tasmo-pc.local")


# --------------------------------------------------------------------------
# cert_matches, over captured openssl text
# --------------------------------------------------------------------------


def test_cert_matches_a_certificate_that_covers_everything():
    sans = ["IP:192.168.1.34", "IP:127.0.0.1", "DNS:localhost", "DNS:testhost"]
    assert lan_cert.cert_matches(OPENSSL_TEXT, sans, NOW) is True


def test_cert_matches_accepts_the_bytes_subprocess_hands_back():
    assert lan_cert.cert_matches(OPENSSL_TEXT.encode(), ["DNS:localhost"], NOW) is True


def test_cert_does_not_match_when_the_lan_ip_changed():
    """DHCP moved the machine to a new address overnight. The old certificate
    is perfectly valid and completely useless."""
    sans = ["IP:192.168.1.99", "IP:127.0.0.1", "DNS:localhost"]
    assert lan_cert.cert_matches(OPENSSL_TEXT, sans, NOW) is False


def test_cert_does_not_match_when_it_is_nearly_expired():
    almost = datetime(2027, 10, 1, 0, 0, 0, tzinfo=timezone.utc)  # 23 days left
    assert lan_cert.cert_matches(OPENSSL_TEXT, ["DNS:localhost"], almost) is False


def test_a_month_of_life_left_is_enough():
    fine = datetime(2027, 9, 1, 0, 0, 0, tzinfo=timezone.utc)  # 53 days left
    assert lan_cert.cert_matches(OPENSSL_TEXT, ["DNS:localhost"], fine) is True


def test_the_expiry_window_is_configurable():
    almost = datetime(2027, 10, 1, 0, 0, 0, tzinfo=timezone.utc)
    assert (
        lan_cert.cert_matches(OPENSSL_TEXT, ["DNS:localhost"], almost, min_days_left=7)
        is True
    )


def test_cert_matches_reads_a_space_padded_day():
    """openssl prints "Oct  4" for a single-digit day. strptime on the raw
    string raises; a certificate that cannot be read must not read as valid."""
    assert lan_cert.cert_matches(OPENSSL_TEXT_SHORT_DAY, ["IP:10.0.0.5"], NOW) is True


def test_cert_matches_compares_dns_names_case_insensitively():
    """Windows reports the hostname in whatever case the user typed at setup;
    DNS is case-insensitive and regenerating over letter case is churn."""
    assert lan_cert.cert_matches(OPENSSL_TEXT, ["DNS:TestHost"], NOW) is True


def test_unreadable_openssl_output_never_reads_as_valid():
    """A truncated or garbled description means "regenerate", not "fine"."""
    assert lan_cert.cert_matches("", ["DNS:localhost"], NOW) is False
    assert lan_cert.cert_matches("Could not read certificate", ["DNS:x"], NOW) is False
    assert (
        lan_cert.cert_matches("notAfter=not a date\n", ["DNS:localhost"], NOW) is False
    )


def test_a_naive_now_is_treated_as_utc():
    """Callers reach for datetime.utcnow() out of habit; comparing a naive to
    an aware datetime raises TypeError, which would crash a launch."""
    assert (
        lan_cert.cert_matches(OPENSSL_TEXT, ["DNS:localhost"], NOW.replace(tzinfo=None))
        is True
    )


# --------------------------------------------------------------------------
# ensure_lan_cert without openssl
# --------------------------------------------------------------------------


def test_no_openssl_returns_none_and_warns_once(
    data_dir: Path, monkeypatch: pytest.MonkeyPatch, caplog
):
    """The app must start regardless: a LAN listener is a convenience. One
    warning, naming the fix -- not a stack trace and not silence."""
    monkeypatch.setattr(lan_cert, "find_openssl", lambda explicit=None: None)
    with caplog.at_level(logging.WARNING, logger="backend.lib.lan_cert"):
        assert lan_cert.ensure_lan_cert(["192.168.1.34"]) is None
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "openssl" in warnings[0].getMessage()
    assert not lan_cert.cert_file().exists()


def test_a_failing_openssl_returns_none_and_warns_once(
    data_dir: Path, monkeypatch: pytest.MonkeyPatch, caplog
):
    monkeypatch.setattr(lan_cert, "find_openssl", lambda explicit=None: "openssl")

    def failed(argv, timeout=60.0):
        return subprocess.CompletedProcess(argv, 1, "", "unknown option -addext")

    monkeypatch.setattr(lan_cert, "_run", failed)
    with caplog.at_level(logging.WARNING, logger="backend.lib.lan_cert"):
        assert lan_cert.ensure_lan_cert(["192.168.1.34"]) is None
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert len(warnings) == 1
    assert "-addext" in warnings[0].getMessage()


def test_an_openssl_that_cannot_be_executed_returns_none(
    data_dir: Path, monkeypatch: pytest.MonkeyPatch, caplog
):
    """A stale path in the fallback list, a file that is not an executable, a
    sandbox that refuses the spawn. None of it may reach the launcher."""
    monkeypatch.setattr(lan_cert, "find_openssl", lambda explicit=None: "openssl")

    def boom(argv, timeout=60.0):
        raise OSError(13, "permission denied")

    monkeypatch.setattr(lan_cert, "_run", boom)
    with caplog.at_level(logging.WARNING, logger="backend.lib.lan_cert"):
        assert lan_cert.ensure_lan_cert([]) is None
    assert len([r for r in caplog.records if r.levelno == logging.WARNING]) == 1


def test_a_failed_generation_leaves_no_temp_files_behind(
    data_dir: Path, monkeypatch: pytest.MonkeyPatch
):
    """The temp key is created at 0o600 BEFORE openssl runs, so a failure that
    left it there would leave an empty key file in the data tree forever."""
    monkeypatch.setattr(lan_cert, "find_openssl", lambda explicit=None: "openssl")
    monkeypatch.setattr(
        lan_cert,
        "_run",
        lambda argv, timeout=60.0: subprocess.CompletedProcess(argv, 1, "", "nope"),
    )
    assert lan_cert.ensure_lan_cert(["10.0.0.4"]) is None
    assert sorted(p.name for p in lan_cert.cert_dir().iterdir()) == []


def test_find_openssl_rejects_a_name_that_does_not_exist():
    assert lan_cert.find_openssl("C:/nope/openssl-not-here.exe") is None


# --------------------------------------------------------------------------
# ensure_lan_cert with the real openssl
# --------------------------------------------------------------------------


@needs_openssl
def test_generation_covers_every_address_and_the_hostname(data_dir: Path):
    paths_out = lan_cert.ensure_lan_cert(["192.168.1.34"], now=NOW)
    assert paths_out is not None
    assert paths_out.cert == lan_cert.cert_file()
    assert paths_out.key == lan_cert.key_file()
    assert paths_out.cert.read_bytes().startswith(b"-----BEGIN CERTIFICATE-----")
    assert b"PRIVATE KEY" in paths_out.key.read_bytes()

    described = subprocess.run(
        [
            lan_cert.find_openssl(),
            "x509",
            "-in",
            str(paths_out.cert),
            "-noout",
            "-ext",
            "subjectAltName",
            "-enddate",
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert "IP Address:192.168.1.34" in described
    assert "IP Address:127.0.0.1" in described
    assert "DNS:localhost" in described
    # The freshly written certificate satisfies the very predicate the
    # launcher will use on the next start.
    sans = lan_cert.desired_sans(["192.168.1.34"], socket.gethostname())
    assert lan_cert.cert_matches(described, sans, NOW) is True


@needs_openssl
def test_generation_leaves_no_temp_files_and_a_locked_down_key(data_dir: Path):
    assert lan_cert.ensure_lan_cert(["192.168.1.34"]) is not None
    left = sorted(p.name for p in lan_cert.cert_dir().iterdir())
    assert left == ["lan-cert.pem", "lan-key.pem"]
    if sys.platform != "win32":
        # On Windows a POSIX mode only clears the read-only bit; there is no
        # multi-user ACL here to assert on (see backend/lib/atomic.py).
        assert lan_cert.key_file().stat().st_mode & 0o777 == 0o600


@needs_openssl
def test_a_good_certificate_is_reused_rather_than_regenerated(data_dir: Path):
    """Regenerating on every launch would make every device on the LAN show
    the certificate interstitial again, every time."""
    first = lan_cert.ensure_lan_cert(["192.168.1.34"])
    assert first is not None
    before = first.cert.read_bytes()
    again = lan_cert.ensure_lan_cert(["192.168.1.34"])
    assert again is not None
    assert again.cert.read_bytes() == before


@needs_openssl
def test_a_new_lan_address_regenerates(data_dir: Path):
    first = lan_cert.ensure_lan_cert(["192.168.1.34"])
    assert first is not None
    before = first.cert.read_bytes()
    moved = lan_cert.ensure_lan_cert(["192.168.1.77"])
    assert moved is not None
    assert moved.cert.read_bytes() != before
    described = subprocess.run(
        [
            lan_cert.find_openssl(),
            "x509",
            "-in",
            str(moved.cert),
            "-noout",
            "-ext",
            "subjectAltName",
            "-enddate",
        ],
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    assert "IP Address:192.168.1.77" in described


@needs_openssl
def test_an_expiring_certificate_is_replaced(data_dir: Path):
    first = lan_cert.ensure_lan_cert(["192.168.1.34"])
    assert first is not None
    before = first.cert.read_bytes()
    # A launch a year and a bit later: fewer than MIN_DAYS_LEFT days remain.
    later = datetime.now(timezone.utc) + timedelta(days=lan_cert.CERT_DAYS - 5)
    replaced = lan_cert.ensure_lan_cert(["192.168.1.34"], now=later)
    assert replaced is not None
    assert replaced.cert.read_bytes() != before


@needs_openssl
def test_a_corrupt_certificate_on_disk_is_replaced(data_dir: Path):
    """Half a file from a crashed write, or something that is not a
    certificate at all. openssl x509 fails to read it; the launcher must get a
    working pair back, not None."""
    lan_cert.cert_dir().mkdir(parents=True, exist_ok=True)
    lan_cert.cert_file().write_text("not a certificate")
    lan_cert.key_file().write_text("not a key")
    paths_out = lan_cert.ensure_lan_cert(["192.168.1.34"])
    assert paths_out is not None
    assert paths_out.cert.read_bytes().startswith(b"-----BEGIN CERTIFICATE-----")


@needs_openssl
@pytest.mark.parametrize("broken_key", ["", "   \n", "not a key", "\x00\x01\x02"])
def test_a_corrupt_key_beside_a_good_certificate_is_replaced(
    data_dir: Path, broken_key: str
):
    """The reuse path validated the certificate with ``openssl x509`` and never
    looked at the key, so an empty or truncated key file -- a crashed write, a
    half-synced folder -- was handed to the listener at every launch and vite
    died on it every time. The pair is regenerated instead."""
    first = lan_cert.ensure_lan_cert(["192.168.1.34"])
    assert first is not None
    good_cert = first.cert.read_bytes()
    lan_cert.key_file().write_text(broken_key)

    again = lan_cert.ensure_lan_cert(["192.168.1.34"])
    assert again is not None
    key = again.key.read_bytes()
    assert key.startswith(b"-----BEGIN "), "the key was reused as it was"
    assert b"PRIVATE KEY" in key
    # And the certificate now matches that key, so it had to be reissued too.
    assert again.cert.read_bytes() != good_cert
    assert again.cert.read_bytes().startswith(b"-----BEGIN CERTIFICATE-----")


@needs_openssl
def test_the_data_dir_is_created_when_it_does_not_exist(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    fresh = tmp_path / "never-existed" / "data"
    monkeypatch.setenv("theDAW_DATA_DIR", str(fresh))
    assert lan_cert.ensure_lan_cert(["10.1.2.3"]) is not None
    assert (fresh / "lan-cert" / "lan-cert.pem").exists()
