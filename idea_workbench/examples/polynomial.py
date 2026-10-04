"""Small real CPU experiment; reports parsed configuration and observations."""
import argparse
import json
import math
import os
import random
from pathlib import Path


def solve(matrix, target):
    rows = [list(a) + [b] for a, b in zip(matrix, target)]
    n = len(rows)
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(rows[r][col]))
        rows[col], rows[pivot] = rows[pivot], rows[col]
        scale = rows[col][col]
        if abs(scale) < 1e-15:
            raise ValueError("Singular fit")
        rows[col] = [v / scale for v in rows[col]]
        for r in range(n):
            if r != col:
                scale = rows[r][col]
                rows[r] = [v - scale * w for v, w in zip(rows[r], rows[col])]
    return [row[-1] for row in rows]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--degree", type=int, default=3)
    parser.add_argument("--samples", type=int, default=18)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()
    if not 1 <= args.degree <= 12 or not 12 <= args.samples <= 10000:
        parser.error("degree must be 1..12; samples must be 12..10000")
    rng = random.Random(args.seed)
    xs = [-1 + 2 * i / (args.samples - 1) for i in range(args.samples)]
    ys = [math.sin(3 * x) + rng.gauss(0, .15) for x in xs]
    features = [[x ** i for i in range(args.degree + 1)] for x in xs]
    ridge = 1e-8
    matrix = [[sum(row[i] * row[j] for row in features) + (ridge if i == j else 0)
               for j in range(args.degree + 1)] for i in range(args.degree + 1)]
    weights = solve(matrix, [sum(row[i] * y for row, y in zip(features, ys)) for i in range(args.degree + 1)])

    def rmse(points, labels):
        return math.sqrt(sum((sum(w * x ** i for i, w in enumerate(weights)) - y) ** 2
                             for x, y in zip(points, labels)) / len(points))

    interpolation = [-.975 + 1.95 * i / 39 for i in range(40)]
    extrapolation = [1.05 + .95 * i / 39 for i in range(40)]
    metrics = {"train_rmse": rmse(xs, ys), "interpolation_rmse": rmse(interpolation, [math.sin(3*x) for x in interpolation]),
               "extrapolation_rmse": rmse(extrapolation, [math.sin(3*x) for x in extrapolation])}
    config = vars(args) | {"ridge": ridge, "noise_std": .15, "data": "synthetic-sin3x-v1", "train_range": [-1, 1], "extrapolation_range": [1.05, 2]}
    Path(os.environ.get("IDEA_CONFIG_PATH", "config.json")).write_text(json.dumps(config), encoding="utf-8")
    Path(os.environ.get("IDEA_METRICS_PATH", "metrics.json")).write_text(json.dumps(metrics), encoding="utf-8")
    print(json.dumps({"config": config, "metrics": metrics}))


if __name__ == "__main__":
    main()
