"""Store the macOS signing and notarization credentials for the release workflow.

Builds the signing identity from a Developer ID Application certificate and the
private key its request was made with, checks it signs and that Apple accepts
the notarization key, then saves everything in the repo's release environment.
Nothing secret is printed or written anywhere else, and nothing is uploaded
unless every check passes. Run it again when the certificate is renewed.

    python3 scripts/configure-release-secrets.py \\
        --certificate ~/Downloads/developerID_application.cer \\
        --private-key ~/.config/scratch-release/developer-id.key \\
        --notary-key ~/Downloads/AuthKey_ABCDE12345.p8 --issuer <issuer id>
"""
import argparse
import base64
import hashlib
import os
import pathlib
import re
import secrets
import subprocess
import tempfile

REPO = "mickr/scratch"
ENVIRONMENT = "release"
TEAM_ID = "M9G92WURV3"  # Must match APPLE_TEAM_ID in .github/workflows/release.yml.
OPENSSL = "/usr/bin/openssl"


def run(command, **kwargs):
    return subprocess.run(command, capture_output=True, check=True, **kwargs).stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--certificate", type=pathlib.Path, required=True, help="Developer ID Application .cer from Apple")
    parser.add_argument("--private-key", type=pathlib.Path, required=True, help="Key the certificate request was made with")
    parser.add_argument("--notary-key", type=pathlib.Path, required=True, help="App Store Connect API key (AuthKey_<ID>.p8)")
    parser.add_argument("--issuer", required=True, help="App Store Connect issuer ID")
    args = parser.parse_args()

    key_id = re.fullmatch(r"AuthKey_([A-Z0-9]+)\.p8", args.notary_key.name)
    if not key_id:
        raise SystemExit("Keep the API key's original AuthKey_<ID>.p8 file name; it carries the key ID")
    key_id = key_id.group(1)

    raw = args.certificate.read_bytes()
    pem = raw if raw.startswith(b"-----BEGIN") else run([OPENSSL, "x509", "-inform", "DER"], input=raw)
    der = run([OPENSSL, "x509", "-outform", "DER"], input=pem)
    subject = run([OPENSSL, "x509", "-noout", "-subject"], input=pem).decode()
    if "Developer ID Application" not in subject or f"OU={TEAM_ID}" not in subject.replace(" ", ""):
        raise SystemExit(f"Not a Developer ID Application certificate for team {TEAM_ID}")
    certificate_key = run([OPENSSL, "x509", "-noout", "-pubkey"], input=pem)
    private_key = run([OPENSSL, "pkey", "-in", str(args.private_key), "-pubout"])
    if certificate_key != private_key:
        raise SystemExit("The certificate wasn't issued for this private key")
    identity = hashlib.sha1(der).hexdigest().upper()

    password = secrets.token_hex(24)
    with tempfile.TemporaryDirectory() as work:
        work = pathlib.Path(work)
        (work / "certificate.pem").write_bytes(pem)
        os.chmod(work, 0o700)
        bundle = work / "identity.p12"
        run([OPENSSL, "pkcs12", "-export", "-inkey", str(args.private_key), "-in", str(work / "certificate.pem"),
             "-name", "Scratch release", "-out", str(bundle), "-passout", "env:P12"], env={**os.environ, "P12": password})
        # Import into a throwaway keychain the way CI does, and require a valid
        # code-signing identity, so a bad bundle never reaches the workflow.
        keychain = work / "check.keychain-db"
        keychain_password = secrets.token_hex(16)
        run(["security", "create-keychain", "-p", keychain_password, str(keychain)])
        try:
            run(["security", "unlock-keychain", "-p", keychain_password, str(keychain)])
            run(["security", "import", str(bundle), "-P", password, "-f", "pkcs12", "-k", str(keychain)])
            identities = run(["security", "find-identity", "-v", "-p", "codesigning", str(keychain)]).decode()
        finally:
            subprocess.run(["security", "delete-keychain", str(keychain)], capture_output=True)
        if identity not in identities:
            raise SystemExit("The identity didn't import as a valid code-signing identity")
        bundle_bytes = bundle.read_bytes()

    check = subprocess.run(["xcrun", "notarytool", "history", "--key", str(args.notary_key), "--key-id", key_id,
                            "--issuer", args.issuer, "--output-format", "json"], capture_output=True)
    if check.returncode:
        raise SystemExit("Apple rejected the notarization API key; nothing was uploaded")

    values = {
        "SCRATCH_CERTIFICATE_BASE64": base64.b64encode(bundle_bytes),
        "SCRATCH_CERTIFICATE_PASSWORD": password.encode(),
        "SCRATCH_NOTARY_API_KEY": args.notary_key.read_bytes(),
    }
    for name, value in values.items():
        run(["gh", "secret", "set", name, "--repo", REPO, "--env", ENVIRONMENT], input=value)
        print(f"Saved secret {name}")
    for name, value in {
        "SCRATCH_SIGN_IDENTITY": identity,
        "SCRATCH_NOTARY_KEY_ID": key_id,
        "SCRATCH_NOTARY_ISSUER_ID": args.issuer,
    }.items():
        run(["gh", "variable", "set", name, "--repo", REPO, "--env", ENVIRONMENT, "--body", value])
        print(f"Saved variable {name}")
    print(f"Release signing configured for identity {identity}.")


if __name__ == "__main__":
    main()
