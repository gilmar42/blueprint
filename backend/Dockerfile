FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN apk add --no-cache ffmpeg font-dejavu \
    && npm ci --omit=dev \
    && addgroup -S app && adduser -S -u 10001 -G app app \
    && mkdir -p /data/uploads && chown -R app:app /data
COPY --chown=app:app src ./src
COPY --chown=app:app internal/platform/migrations ./internal/platform/migrations
ENV FFMPEG_PATH=ffmpeg FONT_FILE=/usr/share/fonts/TTF/DejaVuSans.ttf
USER app

FROM runtime AS api
EXPOSE 8080
CMD ["npm", "run", "api"]

FROM node:22-bookworm-slim AS worker
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      blender colmap ffmpeg fontconfig fonts-dejavu-core git cmake build-essential pkg-config \
      libeigen3-dev libopencv-dev libceres-dev libcgal-dev libboost-filesystem-dev libboost-program-options-dev \
      libboost-iostreams-dev libboost-serialization-dev libboost-system-dev libboost-thread-dev libglew-dev \
      libglu1-mesa-dev libgl-dev libjpeg-dev libpng-dev libtiff-dev libtbb-dev \
    && rm -rf /var/lib/apt/lists/*
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates \
    && update-ca-certificates && rm -rf /var/lib/apt/lists/*
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends libnanoflann-dev \
    && rm -rf /var/lib/apt/lists/*
COPY patches/openmvs-debian.patch /tmp/openmvs-debian.patch
RUN git clone --depth 1 --branch v2.4.0 --recurse-submodules https://github.com/cdcseacave/openMVS.git /tmp/openMVS \
    && git clone --depth 1 https://github.com/cnr-isti-vclab/vcglib.git /tmp/vcglib \
    && patch -p1 -d /tmp/openMVS < /tmp/openmvs-debian.patch \
    && sed -i 's/REQUIRED IMPORTED_TARGET/QUIET IMPORTED_TARGET/' /tmp/openMVS/libs/IO/CMakeLists.txt \
    && grep -rl 'nanoflann::SearchParameters' /tmp/openMVS/libs | xargs -r sed -i 's/nanoflann::SearchParameters/nanoflann::SearchParams/g' \
    && sed -i 's/AABB_traits_3/AABB_traits/g' /tmp/openMVS/libs/MVS/SceneReconstruct.cpp \
    && sed -i 's/AABB_triangle_primitive_3/AABB_triangle_primitive/g' /tmp/openMVS/libs/MVS/SceneReconstruct.cpp \
    && cmake -S /tmp/openMVS -B /tmp/openMVS/build -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr/local -DVCG_ROOT=/tmp/vcglib \
      -DOpenMVS_USE_CUDA=OFF -DOpenMVS_USE_OPENGL=OFF -DOpenMVS_USE_PYTHON=OFF -DOpenMVS_BUILD_TOOLS=ON \
    && cmake --build /tmp/openMVS/build -j2 \
    && cmake --install /tmp/openMVS/build \
    && rm -rf /tmp/openMVS /tmp/vcglib
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && groupadd --system app && useradd --system --uid 10001 --gid app app \
    && mkdir -p /data/uploads && chown -R app:app /data
COPY --chown=app:app src ./src
COPY --chown=app:app internal/platform/migrations ./internal/platform/migrations
ENV PATH=/usr/local/bin/OpenMVS:${PATH} FFMPEG_PATH=/usr/bin/ffmpeg BLENDER_PATH=/usr/bin/blender COLMAP_PATH=/usr/bin/colmap FONT_FILE=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
USER app
CMD ["npm", "run", "worker"]

FROM runtime AS migrate
CMD ["npm", "run", "migrate"]
