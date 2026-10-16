from typing import Any

from flask import jsonify


def ok(data: Any):
    return jsonify({"ok": True, "data": data})


def created(data: Any):
    return jsonify({"ok": True, "data": data}), 201


def bad_request(message: str):
    return jsonify({"ok": False, "error": message}), 400


def not_found(message: str):
    return jsonify({"ok": False, "error": message}), 404
