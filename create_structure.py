from pathlib import Path

#Project Folders
folders = [
    "app",
    "app/templates",
    "app/static/css",
    "app/static/js",
    "worker",
    "infra",
    "scripts",
    "docs",
]

#Project Files

files = [
    #root files
    "requirements.txt",
    ".env",
    ".env.example",
    ".gitignore",
    "README.md",

    #backend files
    "app/__init__.py",
    "app/main.py",
    "app/config.py",
    "app/db.py",
    "app/aws.py",
    "app/rag.py",
    "app/memory.py",
    "app/guardrails.py",
    "app/graph.py",
    "app/observability.py",

    #frontend files
    "app/templates/index.html",
    "app/static/css/style.css",
    "app/static/js/script.js",

    #document ingestion files
    "worker/__init__.py",
    "worker/ingest.py",

    #database files
    "infra/schema.sql",
    "scripts/init_db.py",

    #documentation files
    "docs/SETUP.md",
    "docs/RIUS_OBSERVABILITY.md",
]

def create_structure():
    for folder in folders:
        Path(folder).mkdir(parents=True, exist_ok=True)

    for file in files:
        path = Path(file)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch(exist_ok=True)

    print("Project structure created successfully!")
    print(f"Total folders created: {len(folders)}")
    print(f"Total files created: {len(files)}")

if __name__ == "__main__":
    create_structure()


