#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SLACK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${SLACK_DIR}/.." && pwd)"
GATE_TEST_DIR="${REPO_ROOT}/bee-gate-test"

CONFIG_PATH="${BEE_SLACK_CONFIG:-${SLACK_DIR}/local.config.json}"
NATS_CONTAINER_NAME="${BEE_LOCAL_NATS_CONTAINER_NAME:-bee-local-nats}"
NATS_URL="${BEE_LOCAL_NATS_URL:-nats://127.0.0.1:4222}"
WORKER_SUBJECT="${BEE_GATE_TEST_SUBJECT:-bee.agent.test}"
NATS_HOST="${NATS_URL#nats://}"
NATS_HOST="${NATS_HOST%%:*}"
NATS_PORT="${NATS_URL##*:}"

started_nats=0
bee_gate_test_pid=""

cleanup() {
	if [[ -n "${bee_gate_test_pid}" ]]; then
		kill "${bee_gate_test_pid}" >/dev/null 2>&1 || true
		wait "${bee_gate_test_pid}" >/dev/null 2>&1 || true
	fi

	if [[ "${started_nats}" -eq 1 ]]; then
		docker rm -f "${NATS_CONTAINER_NAME}" >/dev/null 2>&1 || true
	fi
}

trap cleanup EXIT INT TERM

if [[ ! -f "${CONFIG_PATH}" ]]; then
	echo "Missing ${CONFIG_PATH}" >&2
	echo "Copy local.config.example.json to local.config.json and fill in your Slack tokens." >&2
	exit 1
fi

if nc -z "${NATS_HOST}" "${NATS_PORT}" >/dev/null 2>&1; then
	echo "Using existing NATS broker on ${NATS_HOST}:${NATS_PORT}"
else
	if ! command -v docker >/dev/null 2>&1; then
		echo "docker is required to start the local NATS broker." >&2
		exit 1
	fi

	if docker ps --format '{{.Names}}' | grep -qx "${NATS_CONTAINER_NAME}"; then
		echo "Using existing NATS container ${NATS_CONTAINER_NAME}"
	else
		if docker ps -a --format '{{.Names}}' | grep -qx "${NATS_CONTAINER_NAME}"; then
			docker rm -f "${NATS_CONTAINER_NAME}" >/dev/null 2>&1 || true
		fi
		docker run -d --rm --name "${NATS_CONTAINER_NAME}" -p "${NATS_PORT}:4222" nats:2 >/dev/null
		started_nats=1
		echo "Started local NATS broker in container ${NATS_CONTAINER_NAME}"
	fi
fi

echo "Building bee-gate-test"
(cd "${GATE_TEST_DIR}" && npm run build >/dev/null)

echo "Starting bee-gate-test on ${NATS_URL} subject ${WORKER_SUBJECT}"
(
	cd "${GATE_TEST_DIR}"
	BEE_GATE_TEST_NATS_SERVERS="${NATS_URL}" \
	BEE_GATE_TEST_SUBJECT="${WORKER_SUBJECT}" \
	node dist/main.js
) &
bee_gate_test_pid=$!

sleep 1

echo "Building bee-slack"
(cd "${SLACK_DIR}" && npm run build >/dev/null)

echo "Starting bee-slack with ${CONFIG_PATH}"
echo "Press Ctrl+C to stop bee-slack, bee-gate-test, and the local NATS container started by this script."
cd "${SLACK_DIR}"
BEE_SLACK_CONFIG="${CONFIG_PATH}" node dist/main.js
