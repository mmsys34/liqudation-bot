const toAssetsUp = (shares, totalAssets, totalShares) => {
  return mulDivUp(
    shares,
    totalAssets + virtualAssets,
    totalShares + virtualShares
  );
};

export const mulDivUp = (x, y, d) => {
  return (x * y + (d - BigInt(1))) / d;
};
