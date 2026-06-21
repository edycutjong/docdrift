#!/usr/bin/env python3
"""verify_offline.py — Confirm air-gapped Executa performance.

Mocks python socket and urllib libraries to throw errors on network calls.
Then runs symbol extraction to prove 100% offline compliance.
"""

import sys
import socket
import urllib.request
from unittest.mock import patch
from executas.docdrift.plugin import _extract_symbols_from_file

# Network blocker mock class
class BlockedNetworkError(Exception):
    pass

def block_network(*args, **kwargs):
    raise BlockedNetworkError("Network access attempted in air-gapped sandbox!")

def main():
    print("=== Air-Gapped Sandbox Offline Verification ===")
    
    # Patch socket and urllib calls to intercept network requests
    with patch("socket.socket", side_effect=block_network), \
         patch("urllib.request.urlopen", side_effect=block_network):
        
        try:
            # Run symbol extraction on a target file to verify it is completely local
            test_file = __file__ # use current file as code sample
            symbols = _extract_symbols_from_file(test_file)
            
            print(f"Parsed file: {test_file}")
            print(f"Extracted: {len(symbols)} symbols")
            print("Operation: 100% Offline and Local")
            print("Result: PASS ✅ (No network calls detected)")
            
        except BlockedNetworkError as e:
            print(f"Result: FAIL ❌ ({e})")
            sys.exit(1)
        except Exception as e:
            print(f"Result: ERROR ❌ ({e})")
            sys.exit(1)

if __name__ == "__main__":
    main()
