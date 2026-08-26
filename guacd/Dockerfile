# Raises libvncclient's server-cut-text ceiling.
#
# Upstream LibVNCClient refuses any ServerCutText larger than 1 MiB, and it does
# so by returning FALSE out of HandleRFBServerMessage rather than by dropping
# the message. guacd treats that as a fatal protocol error and calls
# guac_client_abort(), so copying more than 1 MiB of text *inside* a VNC session
# kills the whole session — the browser only ever sees "Aborted. See logs.".
#
# Patching the two caps (plain and the zlib/UTF-8 "extended clipboard" variant)
# to match GUAC_COMMON_CLIPBOARD_MAX_LENGTH makes guacd truncate the oversized
# clipboard, which is what it already does for RDP, instead of dropping the
# connection.
#
# Keep CAP == GUAC_COMMON_CLIPBOARD_MAX_LENGTH in the base image: guacd copies
# the text into a stack buffer of exactly that size (see the base-image note in
# the README about the 8 MiB thread stack), and anything above it is truncated
# by guacd anyway.
#
#   docker build -t guacamole/guacd:1.6.0-clip6m-vncclip guacd/
#
# BASE must already be the raised-clipboard image built per the README.

ARG BASE=guacamole/guacd:1.6.0-clip6m

FROM ${BASE} AS build
USER root
ARG CAP=6291456
ARG LIBVNC_VERSION=0.9.15
RUN apk add --no-cache build-base cmake curl zlib-dev libjpeg-turbo-dev openssl-dev \
 && curl -fsSL -o /tmp/lvs.tar.gz \
      "https://github.com/LibVNC/libvncserver/archive/refs/tags/LibVNCServer-${LIBVNC_VERSION}.tar.gz" \
 && mkdir -p /src && tar xzf /tmp/lvs.tar.gz -C /src \
 && cd "/src/libvncserver-LibVNCServer-${LIBVNC_VERSION}" \
 && sed -i "s/msg\.sct\.length > 1<<20/msg.sct.length > ${CAP}/; s/size > (1 << 20)/size > (${CAP})/" \
      src/libvncclient/rfbclient.c \
 `# fail the build rather than ship an unpatched library if upstream moves the checks` \
 && test "$(grep -c "${CAP}" src/libvncclient/rfbclient.c)" = 2 \
 && cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=ON \
      -DWITH_EXAMPLES=OFF -DWITH_TESTS=OFF -DWITH_GTK=OFF -DWITH_FFMPEG=OFF \
 && cmake --build build -j"$(nproc)" --target vncclient

FROM ${BASE}
ARG LIBVNC_VERSION=0.9.15
COPY --from=build \
     /src/libvncserver-LibVNCServer-${LIBVNC_VERSION}/build/libvncclient.so.${LIBVNC_VERSION} \
     /opt/guacamole/lib/libvncclient.so.${LIBVNC_VERSION}
