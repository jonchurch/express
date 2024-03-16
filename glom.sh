#!/opt/homebrew/bin/bash

set -euo pipefail

declare -A orgs_packages

# Read package names from stdin
while IFS= read -r package; do
    repo_url=$(npm view "$package" repository.url 2>/dev/null || echo "no repository")
    if [[ "$repo_url" != "no repository" ]]; then
        if [[ "$repo_url" =~ github\.com[/:]([^/]+)/([^/]+) ]]; then
            org="${BASH_REMATCH[1]}"
            repo="${BASH_REMATCH[2]}"
            repo=${repo%.git}
            # Check if the org exists in the array, initialize if not
            if [[ -z "${orgs_packages[$org]+x}" ]]; then
                orgs_packages["$org"]=""
            fi
            # Ensure uniqueness and avoid trailing spaces
            if [[ ! " ${orgs_packages[$org]} " =~ " ${package} " ]]; then
                orgs_packages["$org"]+="${package} "
            fi
        fi
    fi
done

# Output the JSON structure
echo "{"
for org in "${!orgs_packages[@]}"; do
    # Remove trailing space and convert to an array
    packages_str="${orgs_packages[$org]}"
    packages_str=${packages_str% }
    packages_json_array=$(echo "[\"${packages_str// /\",\"}\"]")
    echo "  \"$org\": $packages_json_array,"
done | sed '$ s/,$//'
echo "}"

