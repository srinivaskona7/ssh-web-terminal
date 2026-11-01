# syntax=docker/dockerfile:1.7
FROM golang:1.22-alpine AS builder
WORKDIR /src
COPY apps/gateway/go.mod apps/gateway/go.sum ./
RUN go mod download
COPY apps/gateway/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/webssh-gateway ./cmd/gateway

FROM gcr.io/distroless/static-debian12:nonroot
USER 65532:65532
WORKDIR /
COPY --from=builder /out/webssh-gateway /webssh-gateway
EXPOSE 8080
ENTRYPOINT ["/webssh-gateway"]
