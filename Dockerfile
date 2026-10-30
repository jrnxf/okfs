# The okfs image: the release's static musl binary on an empty filesystem.
#
# The release workflow builds it from the binaries it already made, with no compile here. Its build
# context holds linux-amd64/okfs and linux-arm64/okfs, and buildx picks one by platform:
#
#   docker buildx build --platform linux/amd64,linux/arm64 -f Dockerfile <context>
#
# The folder to serve is the volume /srv, and the thumbnail cache is the volume /cache. Settings come
# from OKFS_* environment variables (okfs --help lists them) or from arguments after the image name.

# Makes the two folders world-writable, so any --user can fill the cache. It runs on the build host
# whatever the target platform, so building for arm64 needs no emulation.
FROM --platform=$BUILDPLATFORM busybox:1.37 AS dirs
RUN mkdir -m 0755 /srv && mkdir -m 0777 /cache

FROM scratch
ARG TARGETARCH
COPY linux-${TARGETARCH}/okfs /okfs
COPY --from=dirs /srv /srv
COPY --from=dirs /cache /cache
ENV XDG_CACHE_HOME=/cache
VOLUME ["/srv", "/cache"]
EXPOSE 8080
USER 65534:65534
ENTRYPOINT ["/okfs", "--bind", "0.0.0.0", "--port", "8080", "--no-open"]
CMD ["/srv"]
