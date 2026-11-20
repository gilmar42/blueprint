FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api \
    && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/worker ./cmd/worker \
    && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/migrate ./cmd/migrate

FROM alpine:3.21 AS runtime
RUN addgroup -S app && adduser -S -u 10001 -G app app \
    && mkdir -p /data/uploads && chown -R app:app /data
WORKDIR /app
COPY --from=build /out/api /usr/local/bin/api
COPY --from=build /out/worker /usr/local/bin/worker
COPY --from=build /out/migrate /usr/local/bin/migrate
USER app

FROM runtime AS api
EXPOSE 8080
CMD ["/usr/local/bin/api"]

FROM runtime AS worker
CMD ["/usr/local/bin/worker"]

FROM runtime AS migrate
CMD ["/usr/local/bin/migrate"]
