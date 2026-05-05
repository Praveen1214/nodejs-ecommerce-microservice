@ -0,0 +1,37 @@
import pandas as pd

df = pd.read_csv("dataset.csv")

print("Original shape:", df.shape)

# Remove clearly idle / useless rows:
# rows where all traffic/activity indicators are zero
idle_mask = (
    (df["rps_mean"] == 0) &
    (df["rps_std"] == 0) &
    (df["unique_source_count"] == 0) &
    (df["ratio_4xx"] == 0) &
    (df["ratio_5xx"] == 0) &
    (df["latency_mean"] == 0) &
    (df["latency_std"] == 0) &
    (df["inter_arrival_variance"] == 0)
)

idle_count = idle_mask.sum()
print("Idle rows found:", idle_count)

df_clean = df[~idle_mask].copy()

print("Shape after idle row removal:", df_clean.shape)

print("\nMissing values:")
print(df_clean.isnull().sum())

print("\nDuplicate rows:", df_clean.duplicated().sum())

# Keep label column for future testing/evaluation
df_clean.to_csv("clean_dataset.csv", index=False)

print("\nSaved cleaned dataset as clean_dataset.csv")
print("\nFinal columns:")
print(df_clean.columns.tolist())