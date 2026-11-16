"""Store the macOS signing and notarization credentials for the release workflow.

For setting them up again by hand, after renewing the Developer ID certificate
or the app-specific password. Passwords are prompted for and never echoed or
written; nothing is uploaded unless the .p12 imports as a valid Developer ID
Application identity for the team and Apple accepts the notarization login.

    python3 scripts/configure-release-secrets.py ~/Downloads/developer-id.p12
"""
import argparse
import base64
import getpass
import hashlib
import pathlib
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
    parser.add_argument("certificate", type=pathlib.Path, help="Exported Developer ID Application .p12")
    args = parser.parse_args()
    bundle = args.certificate.read_bytes()
    password = getpass.getpass("Password protecting the .p12: ")

    pem = subprocess.run([OPENSSL, "pkcs12", "-in", str(args.certificate), "-clcerts", "-nokeys", "-passin", "stdin"],
                         input=(password + "\n").encode(), capture_output=True)
    if pem.returncode:
        raise SystemExit("Could not read the .p12; check its password")
    subject = run([OPENSSL, "x509", "-noout", "-subject"], input=pem.stdout).decode()
    if "Developer ID Application" not in subject or f"OU={TEAM_ID}" not in subject.replace(" ", ""):
        raise SystemExit(f"Not a Developer ID Application certificate for team {TEAM_ID}")
    identity = hashlib.sha1(run([OPENSSL, "x509", "-outform", "DER"], input=pem.stdout)).hexdigest().upper()

    # Import into a throwaway keychain the way CI does, so a bad bundle never
    # reaches the workflow.
    with tempfile.TemporaryDirectory() as work:
        keychain = pathlib.Path(work) / "check.keychain-db"
        keychain_password = secrets.token_hex(16)
        run(["security", "create-keychain", "-p", keychain_password, str(keychain)])
        try:
            run(["security", "unlock-keychain", "-p", keychain_password, str(keychain)])
            run(["security", "import", str(args.certificate), "-P", password, "-f", "pkcs12", "-k", str(keychain)])
            identities = run(["security", "find-identity", "-v", "-p", "codesigning", str(keychain)]).decode()
        finally:
            subprocess.run(["security", "delete-keychain", str(keychain)], capture_output=True)
    if identity not in identities:
        raise SystemExit("The .p12 didn't import as a valid code-signing identity")

    apple_id = input("Apple ID for notarization: ").strip()
    notary_password = getpass.getpass("App-specific password for notarization: ")
    check = subprocess.run(["xcrun", "notarytool", "history", "--apple-id", apple_id, "--team-id", TEAM_ID,
                            "--password", notary_password, "--output-format", "json"], capture_output=True)
    if check.returncode:
        raise SystemExit("Apple rejected the notarization login; nothing was uploaded")

    for name, value in {
        "SCRATCH_CERTIFICATE_BASE64": base64.b64encode(bundle),
        "SCRATCH_CERTIFICATE_PASSWORD": password.encode(),
        "SCRATCH_NOTARY_PASSWORD": notary_password.encode(),
    }.items():
        run(["gh", "secret", "set", name, "--repo", REPO, "--env", ENVIRONMENT], input=value)
        print(f"Saved secret {name}")
    for name, value in {"SCRATCH_SIGN_IDENTITY": identity, "SCRATCH_APPLE_ID": apple_id}.items():
        run(["gh", "variable", "set", name, "--repo", REPO, "--env", ENVIRONMENT, "--body", value])
        print(f"Saved variable {name}")
    print(f"Release signing configured for identity {identity}.")


if __name__ == "__main__":
    main()
