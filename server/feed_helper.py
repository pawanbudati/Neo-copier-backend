import sys
import json
import pyotp
import argparse
import time

try:
    from neo_api_client import NeoAPI
except ImportError:
    sys.stderr.write("[Python-FeedHelper] Error: 'neo-api-client' library is not installed.\n")
    sys.stderr.write("[Python-FeedHelper] Please run: pip install git+https://github.com/Kotak-Neo/kotak-neo-api.git\n")
    sys.stderr.flush()
    sys.exit(1)

def log(msg):
    sys.stderr.write(f"[Python-FeedHelper] {msg}\n")
    sys.stderr.flush()

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--consumer-key", required=True)
    parser.add_argument("--mobile", required=True)
    parser.add_argument("--ucc", required=True)
    parser.add_argument("--mpin", required=True)
    parser.add_argument("--totp-secret", required=True)
    args = parser.parse_args()

    log("Initializing Kotak Neo API...")
    # The SDK requires consumer_secret in the constructor. Since Neo v2 login
    # doesn't use it, we can pass an empty string safely.
    client = NeoAPI(
        consumer_key=args.consumer_key,
        consumer_secret="",
        environment="prod"
    )

    log("Generating 2FA TOTP...")
    try:
        clean_secret = args.totp_secret.replace(" ", "").upper()
        totp = pyotp.TOTP(clean_secret).now()
    except Exception as e:
        log(f"Error generating TOTP: {e}")
        sys.exit(1)

    log(f"Logging in with UCC: {args.ucc}...")
    try:
        client.totp_login(
            mobile_number=args.mobile,
            ucc=args.ucc,
            totp=totp
        )
        log("TOTP Authentication step 1 success. Validating MPIN...")
        client.totp_validate(mpin=args.mpin)
        log("Authentication successful.")
    except Exception as e:
        log(f"Authentication failed: {e}")
        sys.exit(1)

    # Callbacks for Socket.IO / WebSocket events
    def on_message(message):
        try:
            if isinstance(message, list):
                for item in message:
                    print(json.dumps({"type": "tick", "data": item}), flush=True)
            elif isinstance(message, dict):
                print(json.dumps({"type": "tick", "data": message}), flush=True)
        except Exception as e:
            log(f"Error parsing tick message: {e}")

    def on_error(err):
        log(f"WebSocket Error: {err}")
        print(json.dumps({"type": "error", "message": str(err)}), flush=True)

    def on_close(msg):
        log(f"WebSocket Closed: {msg}")
        print(json.dumps({"type": "closed", "message": str(msg)}), flush=True)

    def on_open(msg):
        log("WebSocket Connection opened successfully.")
        print(json.dumps({"type": "connected"}), flush=True)

    client.on_message = on_message
    client.on_error = on_error
    client.on_close = on_close
    client.on_open = on_open

    log("Connecting to Kotak Neo WebSocket (Socket.IO stream)...")
    try:
        client.connect_websocket()
    except Exception as e:
        log(f"WebSocket connect call failed: {e}")
        sys.exit(1)

    log("Ready. Awaiting subscribe/unsubscribe JSON commands on stdin...")
    
    # Keep reading from stdin for commands from Node.js
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            cmd = json.loads(line)
            action = cmd.get("action")
            tokens = cmd.get("tokens", []) # list of dicts: {"instrument_token": "...", "exchange_segment": "..."}
            
            if action == "subscribe":
                log(f"Sending subscribe command for tokens: {tokens}")
                client.subscribe(instrument_tokens=tokens)
            elif action == "unsubscribe":
                log(f"Sending unsubscribe command for tokens: {tokens}")
                client.unsubscribe(instrument_tokens=tokens)
            else:
                log(f"Unsupported command action: {action}")
        except Exception as e:
            log(f"Error processing command input line: {e}")

if __name__ == "__main__":
    main()
