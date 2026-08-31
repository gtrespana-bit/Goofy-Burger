"""Puntos de acceso público para iniciar sesión en la interfaz web."""

from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Body, Depends, HTTPException, Request, Response

from ..auth import (
    SESSION_COOKIE,
    SESSION_MAX_AGE,
    auth_required,
    create_session,
    delete_session,
    login_user,
    require_auth,
)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/status")
def status():
    return {"auth_enabled": auth_required()}


@router.get("/me")
def me(user: Dict[str, Any] = Depends(require_auth)):
    return {
        "enabled": auth_required(),
        "role": user.get("role", "viewer"),
        "name": user.get("name", user.get("username", "usuario")),
        "username": user.get("username", ""),
        "via": user.get("via", ""),
    }


@router.post("/login")
def login(response: Response, payload: Dict[str, Any] = Body(...)):
    username = str(payload.get("username") or "").strip()
    password = str(payload.get("password") or "")
    code = str(payload.get("code") or "")
    if not auth_required():
        # Sin autenticación no hace falta iniciar sesión; la UI arranca directa.
        return {"ok": True, "enabled": False, "role": "admin"}
    user = login_user(username, password, code)
    if not user:
        raise HTTPException(401, "Usuario, contraseña o código 2FA incorrecto.")
    token = create_session(
        user.get("username", username),
        user.get("role", "viewer"),
        str(user.get("name", "") or ""),
    )
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=SESSION_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=False,  # en LAN no siempre hay HTTPS
        path="/",
    )
    return {
        "ok": True,
        "enabled": True,
        "role": user.get("role", "viewer"),
        "name": user.get("name", user.get("username", username)),
        "username": user.get("username", username),
    }


@router.post("/logout")
def logout(request: Request, response: Response):
    token = request.cookies.get(SESSION_COOKIE, "")
    if token:
        delete_session(token)
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}
