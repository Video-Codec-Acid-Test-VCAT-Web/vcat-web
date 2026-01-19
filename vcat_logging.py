#!/usr/bin/env python3
# vcat_web
#
# SPDX-FileCopyrightText: Copyright (C) 2020-2025 VCAT authors and RoncaTech
# SPDX-License-Identifier: GPL-3.0-or-later
#
# This file is part of vcat_web.
#
# vcat_web is free software: you can redistribute it and/or modify it
# under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# vcat_web is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with vcat_web. If not, see <https://www.gnu.org/licenses/gpl-3.0.html>.
#
# For proprietary/commercial use cases, a written GPL-3.0 waiver or
# a separate commercial license is required from RoncaTech LLC.
#
# All VCAT artwork is owned exclusively by RoncaTech LLC. Use of VCAT logos
# and artwork is permitted for the purpose of discussing, documenting,
# or promoting VCAT itself. Any other use requires prior written permission
# from RoncaTech LLC.
#
# Contact: legal@roncatech.com

"""
Logging configuration with file and console output.
"""

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
