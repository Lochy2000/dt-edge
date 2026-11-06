#!/usr/bin/env bash
# One-command setup for a Raspberry Pi running Raspberry Pi OS.
#   chmod +x setup.sh && ./setup.sh
# Safe to run again: each step skips what's already done.
set -euo pipefail
cd "$(dirname "$0")"

echo "== 1/5 System packages (heavy libraries come from apt, not pip) =="
sudo apt update
sudo apt install -y python3-venv python3-numpy python3-opencv python3-flask python3-yaml \
                    libopenblas-dev i2c-tools v4l-utils git

echo "== 2/5 I2C on, at 400 kHz (needed for a usable MLX90640 frame rate) =="
sudo raspi-config nonint do_i2c 0
CONFIG=/boot/firmware/config.txt
REBOOT_NEEDED=no
if ! grep -q '^dtparam=i2c_arm_baudrate=' "$CONFIG"; then
  echo 'dtparam=i2c_arm_baudrate=400000' | sudo tee -a "$CONFIG" >/dev/null
  REBOOT_NEEDED=yes
fi

echo "== 3/5 TC-08 driver (only if Pico's package source is already set up) =="
if apt-cache show libusbtc08 >/dev/null 2>&1; then
  sudo apt install -y libusbtc08
  echo /opt/picoscope/lib | sudo tee /etc/ld.so.conf.d/picoscope.conf >/dev/null
  sudo ldconfig
else
  echo "   skipped: add Pico's apt source first (picotech.com/downloads/linux), then re-run"
fi

echo "== 4/5 Python environment =="
[ -d venv ] || python3 -m venv --system-site-packages venv
venv/bin/pip install --upgrade pip >/dev/null
venv/bin/pip install -r requirements.txt
grep -v '^\s*#' requirements-optional.txt | sed 's/\s#.*//' | while read -r pkg; do
  [ -z "$pkg" ] && continue
  venv/bin/pip install "$pkg" || echo "   optional package failed, its sensor will show ERROR: $pkg"
done

echo "== 5/5 Local settings =="
[ -f .env ] || cp .env.example .env

echo
echo "Done. Check the hardware with:  i2cdetect -y 1   and   v4l2-ctl --list-devices"
echo "Start the dashboard with:       ./run.sh"
[ "$REBOOT_NEEDED" = yes ] && echo "I2C speed changed: run  sudo reboot  first."
exit 0
