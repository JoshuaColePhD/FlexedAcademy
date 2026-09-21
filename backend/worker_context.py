"""Tenant identity for pooled worker calls, without sharing DB transactions."""
from . import db


def run_as_user(owner_id, function, *args, **kwargs):
    with db.as_user(owner_id):
        return function(*args, **kwargs)
