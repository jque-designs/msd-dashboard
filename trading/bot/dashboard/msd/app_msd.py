from flask import Flask, jsonify, render_template

from msd_engine import calc_all

app = Flask(__name__)
SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]


@app.route("/")
def index():
    return render_template("msd.html", symbols=SYMBOLS)


@app.route("/api/msd/<symbol>")
def api_msd(symbol):
    if symbol not in SYMBOLS:
        return jsonify({"error": "invalid symbol"}), 400
    try:
        data = calc_all(symbol)
        return jsonify(data)
    except Exception as e:  # noqa: BLE001
        import traceback

        print(traceback.format_exc())
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5001, debug=False)
