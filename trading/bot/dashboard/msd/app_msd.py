from flask import Flask, render_template, jsonify, send_from_directory
import os

app = Flask(__name__, static_folder="static", static_url_path="/static")
SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]

@app.route("/")
def index():
    return render_template("msd.html")

# Keep old API endpoints available (unused by new frontend but useful for debugging)
@app.route("/api/msd/<symbol>")
def api_msd(symbol):
    if symbol not in SYMBOLS:
        return jsonify({"error": "invalid symbol"}), 400
    try:
        from msd_engine import calc_all
        data = calc_all(symbol)
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=False)
