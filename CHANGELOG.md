# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Structured JSON logging for daemon HTTP/self-healing lifecycle.
- Prometheus metrics export endpoint with request and scheduler counters.
- Built-in daemon rate limiting controls.
- Full stdio MCP transport with modular tool routing.
- MCP codec tools (`cortexa_encode_mcp_ctx`, `cortexa_decode_mcp_ctx`).
- Security hardening guide and observability guide.

### Changed

- Daemon health payload now reports observability configuration.
- CI now runs MCP and observability-focused tests.

## [0.1.0] - 2026-04-19

### Added

- Initial public alpha release with local-first memory runtime, daemon APIs, compaction pipeline, and CX-LINK protocol support.
