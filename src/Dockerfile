# Build stage
FROM golang:1.23 as build
WORKDIR /src
COPY go.mod .
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o /tracksvc main.go

# Runtime
FROM gcr.io/distroless/static-debian12:nonroot
ENV DROPBOX_ROOT=/Tracks BIND_ADDR=:8080
EXPOSE 8080
COPY --from=build /tracksvc /tracksvc
USER nonroot:nonroot
ENTRYPOINT ["/tracksvc"]

