#!/usr/bin/env bash
# TEST-ONLY certificates for apps/api/test/billing.test.ts. These are NOT Apple certificates and NOT secrets.
#
# Builds two throwaway ECDSA chains shaped like the App Store's JWS signing chain
# (root -> intermediate -> leaf, with Apple's marker extensions on the intermediate and the leaf):
#   root.pem, intermediate.pem, leaf.pem (+ leaf.key)   the chain the tests pin in place of "Apple Root CA - G3"
#   leaf-unmarked.pem (+ leaf-unmarked.key)              issued by the same intermediate, without the leaf marker OID
#   rogue-root.pem, rogue-intermediate.pem, rogue-leaf.pem (+ rogue-leaf.key)
#                                                        an identical-looking chain under a different root
# Only the leaf keys are kept (tests sign JWS with them). Root and intermediate keys are thrown away.
# The committed output is what CI uses, so CI never needs openssl. Re-run only to rotate the fixtures
# (the certificates are valid for 20 years from generation; tests pin their clock inside that window):
#   apps/api/test/fixtures/billing/generate.sh
set -euo pipefail
cd "$(dirname "$0")"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
DAYS=7300

cat > "$work/ext.cnf" <<'CNF'
[root]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
[intermediate]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
1.2.840.113635.100.6.2.1 = ASN1:NULL
[leaf]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
1.2.840.113635.100.6.11.1 = ASN1:NULL
[leaf_unmarked]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
CNF

# chain <file prefix> <subject label>
chain() {
  local p=$1 label=$2
  openssl ecparam -name secp384r1 -genkey -noout -out "$work/${p}root.key"
  openssl req -x509 -new -key "$work/${p}root.key" -sha384 -days "$DAYS" \
    -subj "/CN=TEST ONLY ${label} Root CA - G3/O=Trialguard tests" -extensions root -config "$work/ext.cnf" -out "${p}root.pem"

  openssl ecparam -name prime256v1 -genkey -noout -out "$work/${p}intermediate.key"
  openssl req -new -key "$work/${p}intermediate.key" -subj "/CN=TEST ONLY ${label} Intermediate/O=Trialguard tests" -out "$work/${p}intermediate.csr"
  openssl x509 -req -in "$work/${p}intermediate.csr" -CA "${p}root.pem" -CAkey "$work/${p}root.key" -CAcreateserial -CAserial "$work/${p}root.srl" \
    -sha384 -days "$DAYS" -extfile "$work/ext.cnf" -extensions intermediate -out "${p}intermediate.pem"

  openssl ecparam -name prime256v1 -genkey -noout -out "$work/${p}leaf.ec"
  openssl pkcs8 -topk8 -nocrypt -in "$work/${p}leaf.ec" -out "${p}leaf.key"
  openssl req -new -key "${p}leaf.key" -subj "/CN=TEST ONLY ${label} Signing Leaf/O=Trialguard tests" -out "$work/${p}leaf.csr"
  openssl x509 -req -in "$work/${p}leaf.csr" -CA "${p}intermediate.pem" -CAkey "$work/${p}intermediate.key" -CAcreateserial -CAserial "$work/${p}int.srl" \
    -sha256 -days "$DAYS" -extfile "$work/ext.cnf" -extensions leaf -out "${p}leaf.pem"

  if [ -z "$p" ]; then
    openssl ecparam -name prime256v1 -genkey -noout -out "$work/unmarked.ec"
    openssl pkcs8 -topk8 -nocrypt -in "$work/unmarked.ec" -out leaf-unmarked.key
    openssl req -new -key leaf-unmarked.key -subj "/CN=TEST ONLY Unmarked Leaf/O=Trialguard tests" -out "$work/unmarked.csr"
    openssl x509 -req -in "$work/unmarked.csr" -CA intermediate.pem -CAkey "$work/intermediate.key" -CAcreateserial -CAserial "$work/int.srl" \
      -sha256 -days "$DAYS" -extfile "$work/ext.cnf" -extensions leaf_unmarked -out leaf-unmarked.pem
  fi
}

chain "" "Fake Apple"
chain "rogue-" "Rogue"
echo "Wrote TEST-ONLY billing fixtures to $(pwd)"
