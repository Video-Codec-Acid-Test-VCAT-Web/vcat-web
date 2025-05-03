import os
import sys
import logging
from datetime import datetime
from pathlib import Path

# Ensure logs directory exists
os.makedirs("logs", exist_ok=True)

# Create timestamped log filename
timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
log_path = Path(f"logs/vcat_server_{timestamp}.log")

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(log_path),
        logging.StreamHandler(sys.stdout),
    ],
)

logger = logging.getLogger("VCAT")

# Log startup message
logger.info("🚀 VCAT Server Launched")

# Update symlink to latest log
latest_symlink = Path("logs/latest.log")
try:
    if latest_symlink.is_symlink() or latest_symlink.exists():
        latest_symlink.unlink()
    latest_symlink.symlink_to(log_path.resolve())
except OSError as e:
    logger.warning(f"⚠️ Failed to create symlink 'latest.log': {e}")
