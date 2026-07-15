export function assertContractVersionDiscipline(previousEntries, currentEntries) {
  const previousById = new Map(previousEntries.map((entry) => [entry.id, entry]));
  for (const current of currentEntries) {
    const previous = previousById.get(current.id);
    if (!previous?.contract_fingerprint || previous.contract_fingerprint === current.contract_fingerprint) continue;
    if (previous.contract_version === current.contract_version) {
      throw new Error(`domain_contract_version_not_bumped:${current.id}`);
    }
  }
}
