#!/usr/bin/env python3
"""Framework-agnostic route-surface snapshot.

Detects whether `app` is a Flask or FastAPI application and enumerates its routes
identically, so the SAME command serves both baseline capture (Flask) and
checkpoint comparison (FastAPI). Path parameters are canonicalized to `{name}`
and trailing slashes are stripped (except root), then a sorted JSON array of
`METHOD PATH` strings is written to stdout.

Only the standard library plus the installed framework is used.
"""

import importlib
import json
import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

PARAM = re.compile(r"<(?:[^:<>]+:)?([^<>]+)>")
IGNORED_METHODS = {"HEAD", "OPTIONS"}


def canonicalize(path: str) -> str:
    path = PARAM.sub(r"{\1}", path)
    if not path.startswith("/"):
        path = "/" + path
    if len(path) > 1 and path.endswith("/"):
        path = path.rstrip("/")
    return path


def flask_routes(app):
    routes = set()
    for rule in app.url_map.iter_rules():
        if rule.endpoint == "static":
            continue
        methods = [m for m in rule.methods if m not in IGNORED_METHODS]
        for method in methods:
            routes.add(f"{method.upper()} {canonicalize(rule.rule)}")
    return routes


def fastapi_routes(app):
    from fastapi.routing import APIRoute

    routes = set()
    for route in app.routes:
        if not isinstance(route, APIRoute):
            continue
        path = canonicalize(route.path)
        for method in route.methods:
            if method in IGNORED_METHODS:
                continue
            routes.add(f"{method.upper()} {path}")
    return routes


def main() -> None:
    module = importlib.import_module("app")
    app = module.app
    if hasattr(app, "url_map"):
        routes = flask_routes(app)
    else:
        routes = fastapi_routes(app)
    print(json.dumps(sorted(routes)))


if __name__ == "__main__":
    main()
