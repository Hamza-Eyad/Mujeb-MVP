#!/usr/bin/env bash
# Lab only: build and install Asterisk from source inside WSL Ubuntu 24.04 (run as root).
# Pinned version and checksum: the build is reproducible and fails if the tarball is not the one we tested.
# chan_websocket's JSON control messages need Asterisk >= 22.8 (DECISIONS A19).
set -euo pipefail
VERSION=22.11.0
SHA256=3bd5ee040509a3d3cd9b1ba9520c18e6ec0a7e7981ca68c457dcd36ba3c54d94
BASE=https://downloads.asterisk.org/pub/telephony/asterisk/releases
TARBALL="asterisk-$VERSION.tar.gz"
export DEBIAN_FRONTEND=noninteractive

echo "== apt packages"
apt-get update -q
apt-get install -y -q build-essential pkg-config wget ca-certificates bzip2 patch \
  libedit-dev libjansson-dev libxml2-dev uuid-dev libsqlite3-dev libssl-dev libsrtp2-dev libcurl4-openssl-dev

echo "== download asterisk-$VERSION"
mkdir -p /usr/src && cd /usr/src
[ -s "$TARBALL" ] || wget -q -O "$TARBALL" "$BASE/$TARBALL"
echo "$SHA256  $TARBALL" | sha256sum -c -
rm -rf "asterisk-$VERSION" && tar xzf "$TARBALL"
cd "asterisk-$VERSION"

echo "== configure"
./configure --with-pjproject-bundled > /tmp/asterisk-configure.log 2>&1 || { tail -40 /tmp/asterisk-configure.log; exit 1; }

echo "== menuselect"
make menuselect.makeopts > /dev/null
menuselect/menuselect --disable BUILD_NATIVE --enable chan_websocket --enable res_websocket_client \
  --enable chan_pjsip --enable codec_g722 menuselect.makeopts

echo "== build"
make -j"$(nproc)" > /tmp/asterisk-build.log 2>&1 || { tail -60 /tmp/asterisk-build.log; exit 1; }

echo "== install"
make install > /tmp/asterisk-install.log 2>&1 || { tail -40 /tmp/asterisk-install.log; exit 1; }
ldconfig

echo "== result"
/usr/sbin/asterisk -V
ls /usr/lib/asterisk/modules/ | grep -E '^(chan_websocket|res_websocket_client|chan_pjsip|codec_g722|res_http_websocket)\.so$'
echo "BUILD_OK"
