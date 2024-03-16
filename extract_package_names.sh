#!/bin/bash

while IFS= read -r line; do
    # Extract the package name from the path
    # This handles both regular and namespaced packages
    pkg_name=$(echo "$line" | awk -F/ '{print $(NF-1) == "node_modules" ? $NF : $(NF-1) "/" $NF}')

    # Output the extracted package name
    echo "$pkg_name"
done

