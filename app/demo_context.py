from dataclasses import dataclass


# Hardcoded user info for demo purposes (replaces full IAM/auth for local testing)
@dataclass(frozen=True)
class Principle:
    subject: str = "demo-operator"
    tenant: str = "demo-workspace"
    groups: tuple[str, ...] = ("workspace",)
    admin: bool = True

def principle() -> Principle:
    return Principle()
