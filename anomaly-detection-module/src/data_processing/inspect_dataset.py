import pandas as pd

df = pd.read_csv("dataset.csv")

print("Shape:", df.shape)
print("\nColumns:")
print(df.columns.tolist())

print("\nFirst 5 rows:")
print(df.head())

print("\nMissing values:")
print(df.isnull().sum())

print("\nLabel counts:")
print(df["label"].value_counts(dropna=False))

print("\nService counts:")
print(df["service"].value_counts(dropna=False))

print("\nBasic statistics:")
print(df.describe(include="all"))