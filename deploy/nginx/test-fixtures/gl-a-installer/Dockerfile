FROM ubuntu:24.04@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        iproute2 \
        jq \
        logrotate \
        nginx \
        openssl \
        python3 \
        systemd \
        util-linux \
    && rm -rf /var/lib/apt/lists/*

LABEL org.opencontainers.image.base.digest="sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90"

WORKDIR /workspace
