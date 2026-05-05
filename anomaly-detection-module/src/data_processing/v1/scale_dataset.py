import pandas as pd
from sklearn.preprocessing import StandardScaler

df = pd.read_csv("clean_dataset.csv")

features = [
"rps_mean",
"rps_std",
"unique_source_count",
"ratio_4xx",
"ratio_5xx",
"latency_mean",
"latency_std",
"inter_arrival_variance"
]

scaler = StandardScaler()

df_scaled = df.copy()
df_scaled[features] = scaler.fit_transform(df[features])

df_scaled.to_csv("scaled_dataset.csv", index=False)

print("Scaling complete")
print("Saved as scaled_dataset.csv")
print("Shape:", df_scaled.shape)