# The okfs image: the release's static musl binary on an empty filesystem.
#
# The release workflow builds it from the binaries it already made, with no compile here. Its build
# context holds linux-amd64/okfs, linux-arm64/okfs and THIRD_PARTY.md, and buildx picks a binary by
# platform:
#
#   docker buildx build --platform linux/amd64,linux/arm64 -f Dockerfile <context>
#
# The folder to serve is the volume /srv, and the thumbnail cache is the volume /cache. Settings come
# from OKFS_* environment variables (okfs --help lists them) or from arguments after the image name.
# The address, port and folder are variables here, not arguments, so a variable of the same name set
# at run time replaces them, and an argument such as --allow-upload leaves the folder alone.

# Makes the two folders world-writable, so any --user can fill the cache. It runs on the build host
# whatever the target platform, so building for arm64 needs no emulation.
FROM --platform=$BUILDPLATFORM busybox:1.37 AS dirs
RUN mkdir -m 0755 /srv && mkdir -m 0777 /cache

FROM scratch
ARG TARGETARCH
# What the registry's page shows, and where the image comes from. The release adds the version.
LABEL org.opencontainers.image.title="okfs" \
      org.opencontainers.image.description="An open-source web file browser in one binary: run it in a folder and flip through every file with the keyboard." \
      org.opencontainers.image.source="https://github.com/jrnxf/okfs" \
      org.opencontainers.image.url="https://okfs.jrnxf.co" \
      org.opencontainers.image.documentation="https://github.com/jrnxf/okfs/blob/main/docs/install.md" \
      org.opencontainers.image.licenses="MIT"
COPY linux-${TARGETARCH}/okfs /okfs
# The licenses of everything compiled into the binary.
COPY THIRD_PARTY.md /THIRD_PARTY.md
COPY --from=dirs /srv /srv
COPY --from=dirs /cache /cache
ENV XDG_CACHE_HOME=/cache
ENV OKFS_BIND=0.0.0.0 OKFS_PORT=8080 OKFS_NO_OPEN=true OKFS_PATH=/srv
WORKDIR /srv
VOLUME ["/srv", "/cache"]
EXPOSE 8080
USER 65534:65534
ENTRYPOINT ["/okfs"]
