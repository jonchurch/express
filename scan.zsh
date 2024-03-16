#!/opt/homebrew/bin/bash

set -euo pipefail

# Initialize an associative array to hold orgs and their packages
declare -A orgs_packages

# Process each dependency to extract the organization and package name
npm ls --json --omit=dev | jq -r '.dependencies | keys | .[]' | while read -r package; do
    # Fetch the npm package information in JSON format
    npm_info_output=$(npm info "$package" --json)
    # Extract the repository URL from the npm package information
    repository_url=$(echo "$npm_info_output" | jq -r '.repository.url // "no repository"')
    # Extract the organization from the repository URL
    if [[ $repository_url != "no repository" ]]; then
        org=$(echo $repository_url | sed -n 's|.*github\.com[:/]\([^/]*\)/.*|\1|p')
        # Append the package to the organization's list
        orgs_packages[$org]+=" $package"
    fi
done

# Convert the associative array to a JSON object
echo "{" > results.json
for org in "${!orgs_packages[@]}"; do
    # Transform the space-delimited string of packages into a JSON array
    packages_array="[\"$(echo ${orgs_packages[$org]} | sed 's/ /", "/g')\"]"
    echo "  \"$org\": $packages_array," >> results.json
done
# Remove the last comma to ensure valid JSON
sed -i '' '$ s/,$//' results.json
echo "}" >> results.json

echo "Results saved in results.json"

