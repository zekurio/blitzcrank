FROM golang:alpine AS build
WORKDIR /build
COPY cmd cmd
COPY pkg pkg
#COPY internal internal
COPY go.mod .
COPY go.sum .
RUN go mod download
RUN go build -o bin/blitzcrank cmd/blitzcrank/main.go

FROM alpine:latest
WORKDIR /var/opt/blitzcrank
COPY --from=build /build/bin/blitzcrank .
ENTRYPOINT ["/var/opt/blitzcrank/blitzcrank", "-c", "/etc/blitzcrank/config.toml"]