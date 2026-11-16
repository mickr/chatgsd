"""Upload the macOS signing and notarization secrets for the release workflow.

Run locally; passwords are prompted for, never echoed, written, or kept in
shell history. Nothing is uploaded unless the certificate holds the pinned
Developer ID identity and Apple accepts the notarization credentials.

    python3 scripts/configure-release-secrets.py ~/Downloads/developer-id.p12
"""
import argparse
import base64
import getpass
import hashlib
import pathlib
import subprocess

REPO = "mickr/scratch"
ENVIRONMENT = "release"
# Must match APPLE_SIGNING_IDENTITY and APPLE_TEAM_ID in .github/workflows/release.yml.
IDENTITY = "A80792DBE5D34EC0F453FD5FE4E683603D02402C"
TEAM_ID = "M9G92WURV3"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("certificate", type=pathlib.Path, help="Exported Developer ID Application .p12")
    args = parser.parse_args()
    certificate = args.certificate.read_bytes()
    if len(base64.b64encode(certificate)) > 48 * 1024:
        raise SystemExit("The .p12 exceeds GitHub's secret size limit; export only the release identity")

    password = getpass.getpass("Password protecting the exported .p12: ")
    result = subprocess.run(
        ["/usr/bin/openssl", "pkcs12", "-in", str(args.certificate), "-clcerts", "-nokeys", "-passin", "stdin"],
        input=(password + "\n").encode(),
        capture_output=True,
    )
    if result.returncode:
        raise SystemExit("Could not read the .p12; check its password and export format")
    if result.stdout.count(b"-----BEGIN CERTIFICATE-----") != 1:
        raise SystemExit("Export only the Developer ID Application identity")
    der = subprocess.run(
        ["/usr/bin/openssl", "x509", "-outform", "DER"], input=result.stdout, capture_output=True, check=True
    ).stdout
    if hashlib.sha1(der).hexdigest().upper() != IDENTITY:
        raise SystemExit("This isn't the pinned Developer ID Application identity")

    apple_id = input("Apple ID for notarization: ").strip()
    notary_password = getpass.getpass("Apple app-specific password for notarization: ")
    if not password or not apple_id or not notary_password:
        raise SystemExit("Values cannot be empty")
    check = subprocess.run(
        ["xcrun", "notarytool", "history", "--apple-id", apple_id, "--team-id", TEAM_ID,
         "--password", notary_password, "--output-format", "json"],
        capture_output=True,
    )
    if check.returncode:
        raise SystemExit("Apple rejected the notarization credentials; nothing was uploaded")

    secrets = {
        "SCRATCH_CERTIFICATE_BASE64": base64.b64encode(certificate),
        "SCRATCH_CERTIFICATE_PASSWORD": password.encode(),
        "SCRATCH_NOTARY_PASSWORD": notary_password.encode(),
    }
    for name, value in secrets.items():
        subprocess.run(["gh", "secret", "set", name, "--repo", REPO, "--env", ENVIRONMENT], input=value, check=True)
        print(f"Saved {name} in the {ENVIRONMENT} environment")
    subprocess.run(
        ["gh", "variable", "set", "SCRATCH_APPLE_ID", "--repo", REPO, "--env", ENVIRONMENT, "--body", apple_id],
        check=True,
    )
    print("Release secrets configured. No passwords were written to files or printed.")


if __name__ == "__main__":
    main()
