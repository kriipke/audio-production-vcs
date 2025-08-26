all:
	docker buildx build -t avcsviewer:latest .

run:
	docker run --rm -p 8080:8080 -e DROPBOX_TOKEN=$${DROPBOX_TOKEN:?} -e DROPBOX_ROOT="" vcsviewer:latest
